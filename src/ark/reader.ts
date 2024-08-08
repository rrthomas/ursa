// Compile JSON into Ark code.
// © Reuben Thomas 2023-2024
// Released under the MIT license.

import preludeJson from './prelude.json' with {type: 'json'}
import {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  debug,
} from './util.js'
import {
  ArkNull, ArkBoolean, ArkNumber, ArkString, ArkObject, ArkUndefined,
  globals, globalTypes,
} from './data.js'
import {
  ArkExp, ArkLvalue, ArkIf, ArkAnd, ArkOr, ArkSequence, ArkLoop, ArkBreak, ArkContinue,
  ArkSet, ArkLocal, ArkCapture, ArkListLiteral, ArkObjectLiteral, ArkMapLiteral,
  ArkFn, ArkGenerator, ArkReturn, ArkYield,
  ArkProperty, ArkLet, ArkCall, ArkInvoke, ArkLiteral, ArkBoundVar, ArkNamedLoc,
} from './code.js'
import {
  Environment, Frame, Location, TypedLocation,
} from './compiler-utils.js'
import {expToInst} from './flatten.js'
import {ArkState} from './interpreter.js'
import {ArkType, ArkTypedId} from './type.js'

export class ArkCompilerError extends Error {}

export function checkParamList(params: string[]): string[] {
  if (new Set(params).size !== params.length) {
    throw new ArkCompilerError('Duplicate parameters in list')
  }
  return params
}

function paramList(params: [string, boolean][]): Location[] {
  for (const param of params) {
    if (typeof param[0] !== 'string' || typeof param[1] !== 'boolean') {
      throw new ArkCompilerError('Bad type in parameter list')
    }
  }
  checkParamList(params.map((p) => p[0]))
  return params.map((p) => new Location(p[0], p[1]))
}

function bindingList(env: Environment, params: [string, string, unknown][]): ArkBoundVar[] {
  const bindings: ArkBoundVar[] = []
  for (const p of params) {
    if (!(p instanceof Array) || p.length !== 3 || typeof p[0] !== 'string' || typeof p[1] !== 'boolean') {
      throw new ArkCompilerError('invalid let variable binding')
    }
  }
  const boundLocations = paramList(params.map((p) => [p[1], p[0] === 'var'])).map(
    (bl) => new TypedLocation(bl.name, new ArkType([], new Map()), bl.isVar),
  )
  const indexBase = env.top().locals.length
  for (const [i, p] of params.entries()) {
    const val = doCompile(env.push(boundLocations), p[2])
    bindings.push(
      new ArkBoundVar(p[1], val.type, p[0] === 'var', indexBase + i, doCompile(env.push(boundLocations), val)),
    )
  }
  return bindings
}

function listToVals(env: Environment, l: unknown[]): ArkExp[] {
  return l.map((elem) => doCompile(env, elem))
}

function parseType(t: unknown): ArkType {
  if (!(t instanceof Array && t.length === 3 && typeof t[1] === 'string')) {
    throw new ArkCompilerError('Invalid type')
  }
  // FIXME: actually parse the type!
  return ArkNull().type
}

function listToTypes(l: unknown[]): ArkType[] {
  const types: ArkType[] = []
  for (const t of l) {
    if (typeof t === 'string') {
      const type = globalTypes.get(t)
      if (type === undefined) {
        throw new ArkCompilerError(`Invalid type ${t}`)
      }
      types.push(type)
    } else {
      types.push(parseType(t))
    }
  }
  return types
}

export function symRef(env: Environment, name: string): ArkLvalue {
  let lexp
  // Check whether the symbol is a local.
  const locals = env.top().locals
  const j = locals.map((l) => l?.name).lastIndexOf(name)
  if (j !== -1) {
    lexp = new ArkLocal(j, name, locals[j]!.type, locals[j]!.isVar)
  } else {
    // Otherwise, check if it's a capture.
    // Check whether we already have this capture.
    const captures = env.top().captures
    const k = captures.map((c) => c.name).lastIndexOf(name)
    if (k !== -1) {
      lexp = new ArkCapture(k, name, captures[k].type, captures[k].isVar)
    } else {
      // If not, see if it's on the stack to be captured.
      for (let i = 0; i < env.stack.length; i += 1) {
        const locals = env.stack[i].locals
        const j = locals.map((l) => l?.name).lastIndexOf(name)
        if (j !== -1) {
          const k = env.top().captures.length
          const isVar = locals[j]!.isVar
          const type = locals[j]!.type
          lexp = new ArkCapture(k, name, type, isVar)
          env.top().captures.push(new TypedLocation(name, type, isVar))
          break
        }
      }
    }
  }
  // Finally, see if it's a global, and if not, error.
  if (lexp === undefined) {
    if (env.externalSyms.get(name) === ArkUndefined) {
      throw new ArkCompilerError(`Undefined symbol ${name}`)
    }
    lexp = new ArkProperty(new ArkLiteral(env.externalSyms), name)
  }
  lexp.debug.name = name
  lexp.debug.env = JSON.stringify(env)
  return lexp
}

function doCompile(env: Environment, value: unknown): ArkExp {
  if (value === null) {
    return new ArkLiteral(ArkNull())
  }
  if (typeof value === 'boolean') {
    return new ArkLiteral(ArkBoolean(value))
  }
  if (typeof value === 'number') {
    return new ArkLiteral(ArkNumber(value))
  }
  if (typeof value === 'string') {
    return symRef(env, value)
  }
  if (value instanceof Array) {
    if (value.length > 0) {
      switch (value[0]) {
        case 'str':
          if (value.length !== 2 || typeof value[1] !== 'string') {
            throw new ArkCompilerError(`Invalid 'str' ${value}`)
          }
          return new ArkLiteral(ArkString(value[1]))
        case 'let': {
          if (value.length !== 3 || !(value[1] instanceof Array)) {
            throw new ArkCompilerError("Invalid 'let'")
          }
          const params = bindingList(env, value[1] as [string, string, unknown][])
          const compiled = doCompile(
            env.push(params.map((v) => new TypedLocation(v.name, v.type, v.isVar))),
            value[2],
          )
          return new ArkLet(params, compiled)
        }
        case 'fn':
        case 'gen': {
          if (value.length !== 3 || !(value[1] instanceof Array)) {
            throw new ArkCompilerError(`Invalid '${value[0]}'`)
          }
          const params: [string, boolean][] = []
          const types = []
          for (const param of value[1]) {
            if (!(param instanceof Array && param.length === 2 && typeof param[0] === 'string')) {
              throw new ArkCompilerError('Invalid function parameter')
            }
            params.push([param[0], false])
            types.push(param[1])
          }
          const compiledParams = paramList(params)
          const compiledTypes = listToTypes(types)
          const typedParams = compiledParams.map(
            (p, i) => new TypedLocation(p.name, compiledTypes[i], p.isVar),
          )
          const innerEnv = env.pushFrame(new Frame(typedParams, []))
          const compiled = doCompile(innerEnv, value[2])
          return new (value[0] === 'fn' ? ArkFn : ArkGenerator)(
            typedParams.map((p) => new ArkTypedId(p.name, p.type)),
            innerEnv.top().captures.map((c) => symRef(env, c.name) as ArkCapture),
            compiled,
          )
        }
        case 'prop': {
          if (value.length !== 3 || typeof value[1] !== 'string') {
            throw new ArkCompilerError("Invalid 'prop'")
          }
          const compiled = doCompile(env, value[2])
          return new ArkProperty(compiled, value[1])
        }
        case 'set': {
          if (value.length !== 3) {
            throw new ArkCompilerError("Invalid 'set'")
          }
          const compiledRef = doCompile(env, value[1])
          if (!(compiledRef instanceof ArkLvalue)) {
            throw new ArkCompilerError('Invalid lvalue')
          }
          if (compiledRef instanceof ArkNamedLoc && !compiledRef.isVar) {
            throw new ArkCompilerError("Cannot assign to non-'var'")
          }
          const compiledVal = doCompile(env, value[2])
          return new ArkSet(compiledRef, compiledVal)
        }
        case 'list': {
          const elems = listToVals(env, value.slice(1))
          return new ArkListLiteral(elems)
        }
        case 'map': {
          const inits = new Map<ArkExp, ArkExp>()
          for (const pair of value.slice(1)) {
            if (!(pair instanceof Array && pair.length === 2)) {
              throw new ArkCompilerError('Invalid map element')
            }
            const compiledKey = doCompile(env, pair[0])
            const compiledVal = doCompile(env, pair[1])
            inits.set(compiledKey, compiledVal)
          }
          return new ArkMapLiteral(inits)
        }
        case 'seq': {
          if (value.length === 2) {
            return doCompile(env, value[1])
          }
          const elems = listToVals(env, value.slice(1))
          return new ArkSequence(elems)
        }
        case 'if': {
          if (value.length < 3 || value.length > 4) {
            throw new ArkCompilerError("Invalid 'if'")
          }
          const compiledCond = doCompile(env, value[1])
          const compiledThen = doCompile(env, value[2])
          let compiledElse
          if (value.length === 4) {
            compiledElse = doCompile(env, value[3])
          }
          return new ArkIf(compiledCond, compiledThen, compiledElse)
        }
        case 'and': {
          if (value.length !== 3) {
            throw new ArkCompilerError("Invalid 'and'")
          }
          const compiledLeft = doCompile(env, value[1])
          const compiledRight = doCompile(env, value[2])
          return new ArkAnd(compiledLeft, compiledRight)
        }
        case 'or': {
          if (value.length !== 3) {
            throw new ArkCompilerError("Invalid 'or'")
          }
          const compiledLeft = doCompile(env, value[1])
          const compiledRight = doCompile(env, value[2])
          return new ArkOr(compiledLeft, compiledRight)
        }
        case 'loop': {
          if (value.length !== 2) {
            throw new ArkCompilerError("Invalid 'loop'")
          }
          const compiledBody = doCompile(env, value[1])
          return new ArkLoop(compiledBody, env.top().locals.length)
        }
        case 'break': {
          if (value.length < 1 || value.length > 2) {
            throw new ArkCompilerError("Invalid 'break'")
          }
          if (value.length === 2) {
            const compiledBody = doCompile(env, value[1])
            return new ArkBreak(compiledBody)
          }
          return new ArkBreak()
        }
        case 'continue': {
          if (value.length !== 2) {
            throw new ArkCompilerError("Invalid 'continue'")
          }
          return new ArkContinue()
        }
        case 'return':
        case 'yield': {
          if (value.length < 1 || value.length > 2) {
            throw new ArkCompilerError(`Invalid '${value[0]}'`)
          }
          const Constructor = value[0] === 'return' ? ArkReturn : ArkYield
          if (value.length === 2) {
            const compiledBody = doCompile(env, value[1])
            return new Constructor(compiledBody)
          }
          return new Constructor()
        }
        case 'invoke': {
          if (value.length < 3 || typeof value[2] !== 'string') {
            throw new ArkCompilerError("Invalid 'invoke'")
          }
          const compiledObj = doCompile(env, value[1])
          const args = listToVals(env, value.slice(3))
          return new ArkInvoke(compiledObj, value[2], args)
        }
        default: {
          const compiledFn = doCompile(env, value[0])
          const args = listToVals(env, value.slice(1))
          return new ArkCall(compiledFn, args)
        }
      }
    }
  }
  if (typeof value === 'object') {
    const inits = new Map<string, ArkExp>()
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        const compiled = doCompile(env, (value as {[key: string]: unknown})[key])
        inits.set(key, compiled)
      }
    }
    return new ArkObjectLiteral(inits)
  }
  throw new ArkCompilerError(`Invalid value ${value}`)
}

export function compile(expr: unknown, env = new Environment()): ArkExp {
  return doCompile(env, expr)
}

// Compile the prelude and add its values to the globals
const prelude = expToInst(compile(preludeJson))
const preludeObj = await new ArkState(prelude).run() as ArkObject
preludeObj.properties.forEach((val, sym) => globals.set(sym, val))
