// Ursa compiler.
// © Reuben Thomas 2023-2024
// Released under the GPL version 3, or (at your option) any later version.

import {Interval} from 'ohm-js'

import assert from 'assert'
import grammar, {
  Node, NonterminalNode, IterationNode, ThisNode,
  // eslint-disable-next-line import/extensions
} from '../grammar/ursa.ohm-bundle.js'
import {

  debug, valToString,
} from '../ark/util.js'
import {
  ArkVal, ArkNull, ArkBoolean, ArkNumber, ArkString,
} from '../ark/data.js'
import {
  ArkBoundVar, ArkExp, ArkLvalue, ArkLiteral, ArkSequence, ArkIf, ArkLoop, ArkAnd, ArkOr,
  ArkObjectLiteral, ArkListLiteral, ArkMapLiteral,
  ArkCall, ArkInvoke, ArkLet, ArkFn, ArkGenerator, ArkProperty, ArkSet, ArkReturn, ArkYield,
  ArkBreak, ArkContinue, ArkAwait, ArkLaunch, ArkCapture, ArkNamedLoc,
} from '../ark/code.js'
import {
  Frame, Environment, Location, TypedLocation,
} from '../ark/compiler-utils.js'
import {ArkState, ArkRuntimeError} from '../ark/interpreter.js'
import {
  ArkCompilerError, symRef, checkParamList,
} from '../ark/reader.js'
import {ArkFnType, ArkType, ArkTypedId} from '../ark/type.js'

type ParserOperations = {
  toExp(a: ParserArgs): ArkExp
  toLval(a: ParserArgs): ArkLvalue
  toDefinition(a: ParserArgs): Definition
  toKeyValue(a: ParserArgs): KeyValue
  toType(a: ParserArgs): ArkType
  toMethod(a: ParserArgs): ArkFnType
  toParam(a: ParserArgs): ArkTypedId
  toLet(a: ParserArgs): LetBinding
}

type ParserArgs = {
  env: Environment
  inLoop?: boolean
  inFn?: boolean
  inGenerator?: boolean
}

type ParserNode = Node<ParserOperations>
type ParserNonterminalNode = NonterminalNode<ParserOperations>
type ParserIterationNode = IterationNode<ParserOperations>
type ParserThisNode = ThisNode<{a: ParserArgs}, ParserOperations>

// eslint-disable-next-line max-len
const semantics = grammar.createSemantics<ParserNode, ParserNonterminalNode, ParserIterationNode, ParserThisNode, ParserOperations>()

class UrsaError extends Error {
  constructor(source: Interval | undefined, message: string, options: ErrorOptions = {}) {
    super(`${source ? source.getLineAndColumnMessage() : '(unknown location)'}\n${message}`, options)
  }
}

export class UrsaCompilerError extends UrsaError {}

export class UrsaRuntimeError extends UrsaError {
  constructor(public ark: ArkState, source: Interval, message: string, options: ErrorOptions = {}) {
    super(source, message, options)
    const trace = []
    // Exclude top level stack frame from trace-back.
    for (let state: ArkState = ark; state.outerState !== undefined; state = state.outerState) {
      const callerName = state.outerState.frame.debug.callerName
      let fnLocation
      if (state.outerState.outerState !== undefined) {
        const fnName = callerName ?? '(anonymous function)'
        fnLocation = `in ${fnName}`
      } else {
        fnLocation = 'at top level'
      }
      const sourceLoc = state.frame.debug.sourceLoc
      if (sourceLoc !== undefined) {
        const line = sourceLoc.getLineAndColumn()
        trace.push(`line ${line.lineNum}\n    ${line.line}, ${fnLocation}`)
      } else {
        trace.push('(uninstrumented stack frame)')
      }
    }
    if (trace.length > 0) {
      this.message += `

Traceback (most recent call last)
${trace.map((s) => `  ${s}`).join('\n')}`
    }
  }
}

// Base class for parsing the language, extended directly by classes used
// only during parsing.
class AST {}

class Definition extends AST {
  constructor(public ident: ParserNode, public exp: ArkExp) {
    super()
  }
}

class KeyValue extends AST {
  constructor(public key: ArkExp, public exp: ArkExp) {
    super()
  }
}

class Arguments extends AST {
  constructor(public args: ArkExp[]) {
    super()
  }
}

class LetBinding extends AST {
  constructor(public boundVars: ArkBoundVar[]) {
    super()
  }
}

function maybeVal(a: ParserArgs, exp: ParserIterationNode): ArkExp {
  return exp.children.length > 0
    ? exp.children[0].toExp(a)
    : new ArkLiteral(ArkNull())
}

function addLoc<T extends ArkExp>(val: T, node: ParserNode): T {
  // Ensure we don't overwrite more precise location info with less precise.
  assert(val.sourceLoc === undefined, valToString(node))
  val.sourceLoc = node.source
  return val
}

function makeProperty(
  a: ParserArgs,
  exp: ParserNode,
  object: ParserNonterminalNode,
  property: ParserNode,
) {
  return addLoc(new ArkProperty(object.toExp(a), property.sourceString), exp)
}

function makeIfChain(ifs: ArkIf[]): ArkIf {
  if (ifs.length > 1) {
    ifs[0].elseExp = makeIfChain(ifs.slice(1))
  }
  return ifs[0]
}

semantics.addOperation<Definition>('toDefinition(a)', {
  Definition(ident, initializer) {
    return new Definition(ident, initializer.children[1].toExp(this.args.a))
  },
})

semantics.addOperation<KeyValue>('toKeyValue(a)', {
  KeyValue(key, _colon, value) {
    return new KeyValue(
      key.toExp(this.args.a),
      value.toExp(this.args.a),
    )
  },
})

semantics.addOperation<ArkTypedId>('toParam(a)', {
  Param(ident, maybeType) {
    let type = new ArkType([], new Map())
    if (maybeType.children.length > 0) {
      type = maybeType.children[0].children[1].toType(this.args.a)
    }
    return new ArkTypedId(ident.sourceString, type)
  },
})

semantics.addOperation<LetBinding>('toLet(a)', {
  Lets(lets) {
    const letIds: string[] = []
    const letVars: boolean[] = []
    for (const l of (lets.asIteration().children)) {
      const ident = l.children[1].children[0].sourceString
      const isVar = l.children[0].ctorName === 'var'
      letVars.push(isVar)
      if (letIds.includes(ident)) {
        throw new UrsaCompilerError(this.source, `Duplicate identifier in let: ${ident}`)
      }
      letIds.push(ident)
    }
    const locations = letIds.map((id, n) => new Location(id, letVars[n]))
    const innerEnv = this.args.a.env.push(
      locations.map((l) => new TypedLocation(l.name, new ArkType([], new Map()), l.isVar)),
    )
    const parsedLets = []
    for (const l of lets.asIteration().children) {
      const definition = l.children[1].toDefinition({...this.args.a, env: innerEnv})
      parsedLets.push(definition)
    }
    const indexBase = this.args.a.env.top().locals.length
    return new LetBinding(
      parsedLets.map(
        (def, index) => new ArkBoundVar(
          def.ident.sourceString,
          def.exp.type,
          letVars[index],
          indexBase + index,
          def.exp,
        ),
      ),
    )
  },

  Use(_use, pathList) {
    const path = pathList.asIteration().children
    const ident = path[path.length - 1]
    // For path x.y.z, compile `let z = x.use("y", "z")`
    const innerEnv = this.args.a.env.push(
      [new TypedLocation(ident.sourceString, new ArkType([], new Map()), false)],
    )
    const libValue = path[0].toExp({...this.args.a, env: innerEnv})
    debug('Use')
    debug(libValue)
    debug(libValue.type.propertyTypes.get('use'))
    const useProperty = addLoc(new ArkProperty(libValue, 'use'), this)
    const useCallArgs = path.slice(1).map((id) => new ArkLiteral(ArkString(id.sourceString)))
    const useCall = addLoc(new ArkCall(useProperty, useCallArgs), this)
    const index = this.args.a.env.top().locals.length
    return new LetBinding(
      [new ArkBoundVar(ident.sourceString, libValue.type, false, index, useCall)],
    )
  },
})

function makeSequence(a: ParserArgs, seq: ParserNode, exps: ParserNode[]): ArkExp {
  const res = []
  for (const [i, exp] of exps.entries()) {
    if (exp.children[0].ctorName === 'Lets' || exp.children[0].ctorName === 'Use') {
      const compiledLet = exp.toLet(a)
      const innerEnv = a.env.push(
        compiledLet.boundVars.map((bv) => new TypedLocation(bv.name, bv.type, bv.isVar)),
      )
      let letBody: ArkExp
      if (i < exps.length - 1) {
        letBody = makeSequence({...a, env: innerEnv}, seq, exps.slice(i + 1))
      } else {
        letBody = new ArkLiteral(ArkNull())
      }
      res.push(addLoc(new ArkLet(compiledLet.boundVars, letBody), exp))
      break
    } else {
      res.push(exp.toExp(a))
    }
  }
  if (res.length === 1) {
    return res[0]
  }
  return addLoc(new ArkSequence(res), seq)
}

function makeArguments(a: ParserArgs, args: ParserNode): Arguments {
  return new Arguments(
    args.asIteration().children.map((x) => x.toExp(a)),
  )
}

semantics.addOperation<ArkExp>('toExp(a)', {
  Sequence(exps, _sc) {
    return makeSequence(this.args.a, this, exps.asIteration().children)
  },

  PrimaryExp_paren(_open, exp, _close) {
    return exp.toExp(this.args.a)
  },

  List(_open, elems, _maybeComma, _close) {
    return addLoc(
      new ArkListLiteral((elems.asIteration().children).map(
        (x) => x.toExp(this.args.a),
      )),
      this,
    )
  },

  Map(_open, elems, _maybeComma, _close) {
    const inits = new Map<ArkExp, ArkExp>()
    elems.asIteration().children.forEach((value) => {
      const elem = value.toKeyValue(this.args.a)
      inits.set(elem.key, elem.exp)
    })
    return addLoc(new ArkMapLiteral(inits), this)
  },

  Object(maybeType, _open, elems, _maybeComma, _close) {
    // TODO: compile the type, add to ArkObjectLiteral
    if (maybeType.children.length > 0) {
      maybeType.children[0].toType(this.args.a)
    }
    const inits = new Map<string, ArkExp>()
    elems.asIteration().children.forEach((value) => {
      const elem = value.toDefinition(this.args.a)
      inits.set(elem.ident.sourceString, elem.exp)
    })
    return addLoc(new ArkObjectLiteral(inits), this)
  },

  PostfixExp_property(exp, _dot, property) {
    return makeProperty(this.args.a, this, exp, property)
  },
  PostfixExp_invoke(exp, _dot, property, _spaces, _open, args, _maybeComma, _close) {
    return addLoc(
      new ArkInvoke(
        exp.toExp(this.args.a),
        property.sourceString,
        makeArguments(this.args.a, args).args,
      ),
      this,
    )
  },
  PostfixExp_call(exp, _spaces, _open, args, _maybeComma, _close) {
    return addLoc(new ArkCall(exp.toExp(this.args.a), makeArguments(this.args.a, args).args), this)
  },

  Ifs(ifs, _else, elseBlock) {
    const compiledIfs: ArkIf[] = (ifs.asIteration().children).map(
      (x) => x.toExp(this.args.a) as ArkIf,
    )
    if (elseBlock.children.length > 0) {
      compiledIfs.push(elseBlock.children[0].toExp(this.args.a) as ArkIf)
    }
    return makeIfChain(compiledIfs)
  },
  If(_if, cond, thenBlock) {
    return addLoc(new ArkIf(cond.toExp(this.args.a), thenBlock.toExp(this.args.a)), this)
  },

  Fn(type, body) {
    const fnType = type.toMethod(this.args.a)
    const innerEnv = this.args.a.env.pushFrame(
      new Frame(fnType.params.map((p) => new TypedLocation(p.name, p.type, false)), []),
    )
    const compiledBody = body.toExp({
      env: innerEnv,
      inLoop: false,
      inFn: true,
      inGenerator: fnType.isGenerator,
    })
    // TODO: ArkFn should be an ArkObject which contains one method.
    return addLoc(new (fnType.isGenerator ? ArkGenerator : ArkFn)(
      fnType.params,
      innerEnv.top().captures.map(
        (c) => symRef(this.args.a.env, c.name) as ArkCapture,
      ),
      compiledBody,
    ), this)
  },

  Loop(_loop, body) {
    return addLoc(
      new ArkLoop(
        body.toExp({...this.args.a, inLoop: true}),
        this.args.a.env.top().locals.length,
      ),
      this,
    )
  },

  For(_for, ident, _in, iterator, body) {
    const iterVar = ident.sourceString
    const innerEnv = this.args.a.env.push([new TypedLocation('$iter', new ArkType([], new Map()), false)])
    const compiledIterator = iterator.toExp({...this.args.a, env: innerEnv})
    const iteratorType = (compiledIterator.type as ArkFnType).returnType
    const loopEnv = innerEnv.push([new TypedLocation(iterVar, iteratorType, false)])
    const compiledIterVar = symRef(loopEnv, iterVar)
    const compiledForBody = body.toExp({...this.args.a, env: loopEnv, inLoop: true})
    const innerIndex = innerEnv.top().locals.length
    const loopBody = addLoc(
      new ArkLet(
        [new ArkBoundVar(iterVar, compiledIterVar.type, false, innerIndex, addLoc(new ArkCall(addLoc(symRef(loopEnv, '$iter'), iterator), []), this))],
        new ArkSequence([
          new ArkIf(
            addLoc(new ArkInvoke(compiledIterVar, 'equals', [new ArkLiteral(ArkNull())]), this),
            new ArkBreak(),
          ),
          compiledForBody,
        ]),
      ),
      this,
    )
    const localsDepth = this.args.a.env.top().locals.length
    return addLoc(
      new ArkLet([new ArkBoundVar('$iter', iteratorType, false, localsDepth, compiledIterator)], new ArkLoop(loopBody, localsDepth + 1)),
      this,
    )
  },

  UnaryExp_bitwise_not(_not, exp) {
    return addLoc(
      new ArkInvoke(exp.toExp(this.args.a), 'bitwiseNot', []),
      this,
    )
  },
  UnaryExp_pos(_plus, exp) {
    return addLoc(
      new ArkInvoke(exp.toExp(this.args.a), 'pos', []),
      this,
    )
  },
  UnaryExp_neg(_minus, exp) {
    return addLoc(
      new ArkInvoke(exp.toExp(this.args.a), 'neg', []),
      this,
    )
  },

  ExponentExp_power(left, _power, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'exp', [right.toExp(this.args.a)]),
      this,
    )
  },

  ProductExp_times(left, _times, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'mul', [right.toExp(this.args.a)]),
      this,
    )
  },
  ProductExp_divide(left, _divide, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'div', [right.toExp(this.args.a)]),
      this,
    )
  },
  ProductExp_mod(left, _mod, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'mod', [right.toExp(this.args.a)]),
      this,
    )
  },

  SumExp_plus(left, _plus, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'add', [right.toExp(this.args.a)]),
      this,
    )
  },
  SumExp_minus(left, _minus, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'sub', [right.toExp(this.args.a)]),
      this,
    )
  },

  CompareExp_eq(left, _eq, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'equals', [right.toExp(this.args.a)]),
      this,
    )
  },
  CompareExp_neq(left, _neq, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'notEquals', [right.toExp(this.args.a)]),
      this,
    )
  },
  CompareExp_lt(left, _lt, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'lt', [right.toExp(this.args.a)]),
      this,
    )
  },
  CompareExp_leq(left, _leq, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'leq', [right.toExp(this.args.a)]),
      this,
    )
  },
  CompareExp_gt(left, _gt, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'gt', [right.toExp(this.args.a)]),
      this,
    )
  },
  CompareExp_geq(left, _geq, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'geq', [right.toExp(this.args.a)]),
      this,
    )
  },

  BitwiseExp_and(left, _and, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'bitwiseAnd', [right.toExp(this.args.a)]),
      this,
    )
  },
  BitwiseExp_or(left, _or, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'bitwiseOr', [right.toExp(this.args.a)]),
      this,
    )
  },
  BitwiseExp_xor(left, _xor, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'bitwiseXor', [right.toExp(this.args.a)]),
      this,
    )
  },
  BitwiseExp_lshift(left, _lshift, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'shiftLeft', [right.toExp(this.args.a)]),
      this,
    )
  },
  BitwiseExp_arshift(left, _arshift, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'shiftRight', [right.toExp(this.args.a)]),
      this,
    )
  },
  BitwiseExp_lrshift(left, _lrshift, right) {
    return addLoc(
      new ArkInvoke(left.toExp(this.args.a), 'shiftRightArith', [right.toExp(this.args.a)]),
      this,
    )
  },

  LogicNotExp_not(_not, exp) {
    return addLoc(
      new ArkInvoke(exp.toExp(this.args.a), 'not', []),
      this,
    )
  },

  LogicExp(node) {
    return node.toExp({...this.args.a})
  },
  LogicExp_and(left, _and, right) {
    return addLoc(
      new ArkAnd(left.toExp(this.args.a), right.toExp(this.args.a)),
      this,
    )
  },
  LogicExp_or(left, _or, right) {
    return addLoc(
      new ArkOr(left.toExp(this.args.a), right.toExp(this.args.a)),
      this,
    )
  },

  Assignment_ass(lvalue, _ass, exp) {
    const compiledLvalue = lvalue.toLval(this.args.a)
    const compiledValue = exp.toExp(this.args.a)
    if (compiledLvalue instanceof ArkNamedLoc && !compiledLvalue.isVar) {
      throw new UrsaCompilerError(lvalue.source, "Cannot assign to non-'var'")
    }
    return addLoc(new ArkSet(compiledLvalue, compiledValue), this)
  },

  Exp_await(_await, exp) {
    return addLoc(new ArkAwait(exp.toExp(this.args.a)), this)
  },

  Exp_yield(yield_, exp) {
    if (!this.args.a.inGenerator) {
      throw new UrsaCompilerError(yield_.source, 'yield may only be used in a generator')
    }
    return addLoc(new ArkYield(maybeVal(this.args.a, exp)), this)
  },

  Exp_launch(_launch, exp) {
    return addLoc(new ArkLaunch(exp.toExp(this.args.a)), this)
  },

  Statement_break(_break, exp) {
    if (!this.args.a.inLoop) {
      throw new UrsaCompilerError(_break.source, 'break used outside a loop')
    }
    return addLoc(new ArkBreak(maybeVal(this.args.a, exp)), this)
  },
  Statement_continue(_continue) {
    if (!this.args.a.inLoop) {
      throw new UrsaCompilerError(_continue.source, 'continue used outside a loop')
    }
    return addLoc(new ArkContinue(), this)
  },
  Statement_return(return_, exp) {
    if (!this.args.a.inFn) {
      throw new UrsaCompilerError(return_.source, 'return used outside a function')
    }
    return addLoc(new ArkReturn(maybeVal(this.args.a, exp)), this)
  },

  Block(_open, seq, _close) {
    return seq.toExp(this.args.a)
  },

  ident(ident) {
    return addLoc(symRef(this.args.a.env, ident.sourceString), this)
  },

  null(_null) {
    return addLoc(new ArkLiteral(ArkNull()), this)
  },

  bool(flag) {
    return addLoc(new ArkLiteral(ArkBoolean(flag.sourceString === 'true')), this)
  },

  number(_) {
    return addLoc(new ArkLiteral(ArkNumber(parseFloat(this.sourceString))), this)
  },

  string(_open, _str, _close) {
    // FIXME: Parse string properly
    // eslint-disable-next-line no-eval
    return addLoc(new ArkLiteral(ArkString(eval(this.sourceString) as string)), this)
  },

  literalString(_open, str, _close) {
    return addLoc(new ArkLiteral(ArkString(str.sourceString)), this)
  },
})

// TODO: actually collect the type information.
semantics.addOperation<ArkType>('toType(a)', {
  NamedType(name, typeArgs) {
    // TODO: Support type args
    if (typeArgs.children.length > 0) {
      typeArgs.children[0].children[1].asIteration().children.map(
        (child) => child.toType(this.args.a),
      )
    }
    // TODO: add user-defined types to environment
    const typeName = name.sourceString
    const type = this.args.a.env.externalTypes.get(typeName)
    if (type === undefined) {
      throw new ArkCompilerError(`Unknown type ${typeName}`)
    }
    return type
  },
  // TODO
  // Type_intersection(types) {
  //   types.asIteration().children.map((child) => child.toType(this.args.a))
  // },
  Type_fn(type) {
    return type.toMethod(this.args.a)
  },
})

semantics.addOperation<ArkFnType>('toMethod(a)', {
  FnType(fn, _open, params, _maybeComma, _close, returnType) {
    const parsedParams = params.asIteration().children.map((p) => p.toParam(this.args.a))
    try {
      checkParamList(parsedParams.map((p) => p.name))
    } catch (e) {
      if (!(e instanceof ArkCompilerError)) {
        throw e
      }
      throw new UrsaCompilerError(params.source, e.message)
    }
    const parsedReturnType = returnType.toType(this.args.a)
    return new ArkFnType(fn.ctorName === 'gen', parsedParams, parsedReturnType)
  },
})

function badLvalue(node: ParserNode): never {
  throw new UrsaCompilerError(node.source, 'Bad lvalue')
}

// The node passed to toLval is always a PostfixExp or PrimaryExp.
semantics.addOperation<ArkLvalue>('toLval(a)', {
  _terminal() {
    badLvalue(this)
  },
  _nonterminal() {
    badLvalue(this)
  },

  PrimaryExp(exp) {
    return exp.toLval(this.args.a)
  },
  PrimaryExp_ident(sym) {
    return addLoc(symRef(this.args.a.env, sym.sourceString), this)
  },

  PostfixExp(exp) {
    return exp.toLval(this.args.a)
  },
  PostfixExp_property(exp, _dot, property) {
    return makeProperty(this.args.a, this, exp, property)
  },
  PostfixExp_primary(exp) {
    return exp.toLval(this.args.a)
  },
})

export function compile(
  expr: string,
  env: Environment = new Environment(),
  startRule?: string,
): ArkExp {
  const matchResult = grammar.match(expr, startRule)
  if (matchResult.failed()) {
    throw new Error(matchResult.message)
  }
  const ast = semantics(matchResult)
  const args = {
    env, inLoop: false, inFn: false, atSeqTop: true,
  }
  return ast.toExp(args)
}

export async function runWithTraceback(ark: ArkState): Promise<ArkVal> {
  try {
    return await ark.run()
  } catch (e) {
    if (e instanceof ArkRuntimeError) {
      throw new UrsaRuntimeError(e.ark, e.sourceLoc as Interval, e.message, {cause: e})
    }
    throw e
  }
}
