// Generate JavaScript from Ark.
// © Reuben Thomas 2024
// Released under the GPL version 3, or (at your option) any later version.

import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import util from 'util'

import {Operation, run, spawn} from 'effection'
import getSource from 'get-source'
import {
  CodeWithSourceMap, Position, SourceMapConsumer,
  SourceNode,
} from 'source-map'
import StackTracey, {Entry} from '@sc3d/stacktracey'
import {Interval} from 'ohm-js'
import prettier from '@prettier/sync'

import {
  expToInsts, ArkInsts,
  ArkInst, ArkAwaitInst,
  ArkBlockCloseInst, ArkBlockOpenInst, ArkIfBlockOpenInst, ArkLoopBlockOpenInst,
  ArkBreakInst, ArkCallInst, ArkInvokeInst, ArkContinueInst,
  ArkElseBlockInst, ArkElseBlockCloseInst, ArkFnBlockOpenInst, ArkFnBlockCloseInst,
  ArkGeneratorBlockOpenInst, ArkLetCopyInst,
  ArkLaunchBlockOpenInst, ArkLaunchBlockCloseInst, ArkLetBlockOpenInst,
  ArkLocalInst, ArkCaptureInst, ArkListLiteralInst, ArkLiteralInst, ArkMapLiteralInst,
  ArkObjectLiteralInst, ArkPropertyInst, ArkReturnInst, ArkYieldInst,
  ArkSetNamedLocInst, ArkSetPropertyInst,
} from '../flatten.js'
import {
  jsGlobals, ArkBoolean, ArkBooleanVal, ArkList, ArkMap, ArkNull,
  ArkNumber, ArkNullVal, ArkNumberVal, ArkObject, ArkString,
  ArkStringVal, ArkUndefined, ArkVal, NativeFn, ArkOperation,
} from '../data.js'
import {ArkExp} from '../code.js'
import {debug} from '../util.js'
import {
  Environment, Frame, TypedLocation,
} from '../compiler-utils.js'

// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = fileURLToPath(new URL('.', import.meta.url))

class JsRuntimeError extends Error {}

class UrsaStackTracey extends StackTracey {
  isThirdParty(path: string) {
    return super.isThirdParty(path)
      || path.includes('ark/') || path.includes('ursa/')
      || path.includes('effection/') || path.includes('deno.land/x/continuation@')
      || path.includes('node:')
  }

  isClean(entry: Entry, index: number) {
    return super.isClean(entry, index)
      && !entry.file.includes('node:') && !(entry.callee === 'Generator.next')
  }
}

// Compile prelude and add it to globals
export const preludeJs = fs.readFileSync(path.join(__dirname, 'prelude.js'), {encoding: 'utf-8'})
const prelude = await evalArkJs(preludeJs) as ArkObject
prelude.properties.forEach((val, sym) => jsGlobals.set(sym, val))

// Record internal values that are needed by JavaScript at runtime, and
// prevent the TypeScript compiler throwing away their imports.
export const runtimeContext: Record<string, unknown> = {
  ArkUndefined,
  ArkNull,
  ArkNullVal,
  ArkBoolean,
  ArkNumber,
  ArkString,
  ArkObject,
  ArkList,
  ArkMap,
  ArkOperation,
  NativeFn,
  jsGlobals,
}

// Record internal values that are needed by JavaScript at runtime, and
// prevent the TypeScript compiler throwing away their imports.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const externalRuntimeContext: Record<string, unknown> = {
  spawn,
}

function jsMangle(name: string) {
  return `$${name}`
}

function assign(src: string, dest: string) {
  return `${dest} = ${src}`
}

function letAssign(instId: symbol, valueJs: string) {
  assert(valueJs !== undefined, 'valueJs is undefined')
  return `let ${assign(valueJs, instId.description!)}\n`
}

function sourceLocToLineAndCol(sourceLoc?: Interval): [number | null, number | null] {
  const loc = sourceLoc?.getLineAndColumn()
  const line = loc ? loc.lineNum : null
  const col = loc ? loc.colNum - 1 : null // Convert 1-based to 0-based column
  return [line, col]
}

export function flatToJs(insts: ArkInsts, file: string | null = null): CodeWithSourceMap {
  function instsToJs(insts: ArkInsts): SourceNode {
    let env = new Environment()
    function valToJs(val: ArkVal): string {
      if (val instanceof ArkNullVal) {
        return 'ArkNull()'
      } else if (val instanceof ArkBooleanVal) {
        return `ArkBoolean(${val.val})`
      } else if (val instanceof ArkNumberVal) {
        return `ArkNumber(${val.val})`
      } else if (val instanceof ArkStringVal) {
        return `ArkString(${util.inspect(val.val)})`
      } else if (val === env.externalSyms) {
        return 'jsGlobals'
      } else {
        debug(val)
        throw new Error('flat-to-js.valToJs: unknown ArkVal')
      }
    }
    function instToJs(inst: ArkInst): SourceNode {
      const [line, col] = sourceLocToLineAndCol(inst.sourceLoc)
      function sourceNode(stmt: string | SourceNode | (string | SourceNode)[]) {
        return new SourceNode(line, col, file, stmt, env.top().fnName)
      }
      if (inst instanceof ArkLiteralInst) {
        return sourceNode(letAssign(inst.id, valToJs(inst.val)))
      } else if (inst instanceof ArkLaunchBlockCloseInst) {
        return sourceNode([
          `return ${inst.blockId.description!}\n`,
          '})\n',
        ])
      } else if (inst instanceof ArkFnBlockCloseInst) {
        env = env.popFrame()
        if (inst.matchingOpen instanceof ArkGeneratorBlockOpenInst) {
          return sourceNode(['}()\nreturn new NativeFn([\'x\'], (x) => {\nconst {value, done} = gen.next(x)\nreturn done ? ArkNull() : value\n})\n})\n'])
        }
        return sourceNode(['})\n'])
      } else if (inst instanceof ArkIfBlockOpenInst) {
        return sourceNode([letAssign(inst.matchingClose.id, 'ArkNull()'), `if (${inst.condId.description} !== ArkBoolean(false)) {\n`])
      } else if (inst instanceof ArkElseBlockInst) {
        return sourceNode([`${assign(inst.ifBlockId.description!, inst.id.description!)}\n`, '} else {\n'])
      } else if (inst instanceof ArkElseBlockCloseInst) {
        return sourceNode([`${assign(inst.blockId.description!, inst.matchingOpen.id.description!)}\n`, '}\n'])
      } else if (inst instanceof ArkBlockCloseInst) {
        // Also covers ArkLoopBlockCloseInst.
        return sourceNode([`${assign(inst.blockId.description!, inst.id.description!)}\n`, '}\n'])
      } else if (inst instanceof ArkLoopBlockOpenInst) {
        return sourceNode([letAssign(inst.matchingClose.id, 'ArkNull()'), 'for (;;) {\n'])
      } else if (inst instanceof ArkLaunchBlockOpenInst) {
        return sourceNode([letAssign(inst.matchingClose.id, 'yield* spawn(function* () {')])
      } else if (inst instanceof ArkGeneratorBlockOpenInst) {
        env = env.pushFrame(new Frame(
          inst.params.map((p) => new TypedLocation(p.name, p.type, false)),
          [],
          inst.name,
        ))
        return sourceNode([
          letAssign(inst.matchingClose.id, `new NativeFn([${inst.params.map((p) => `'${p.name}'`).join(', ')}], function (${inst.params.map((p) => jsMangle(p.name)).join(', ')}) {\nconst gen = function* () {`),
        ])
      } else if (inst instanceof ArkFnBlockOpenInst) {
        env = env.pushFrame(new Frame(
          inst.params.map((p) => new TypedLocation(p.name, p.type, false)),
          [],
          inst.name,
        ))
        return sourceNode([
          letAssign(inst.matchingClose.id, `new NativeFn([${inst.params.map((p) => `'${p.name}'`).join(', ')}], function* (${inst.params.map((p) => jsMangle(p.name)).join(', ')}) {`),
        ])
      } else if (inst instanceof ArkLetBlockOpenInst) {
        return sourceNode([
          `let ${inst.matchingClose.id.description!}\n`,
          '{\n',
          ...inst.vars.map((v) => `let ${jsMangle(v.name)} = ArkUndefined\n`),
        ])
      } else if (inst instanceof ArkBlockOpenInst) {
        return sourceNode([`let ${inst.matchingClose.id.description!}\n`, '{\n'])
      } else if (inst instanceof ArkAwaitInst) {
        return sourceNode(letAssign(inst.id, `yield* ${inst.argId.description}`))
      } else if (inst instanceof ArkBreakInst) {
        return sourceNode([`${assign(inst.argId.description!, inst.loopInst.matchingClose.id.description!)}\n`, 'break\n'])
      } else if (inst instanceof ArkContinueInst) {
        return sourceNode('continue\n')
      } else if (inst instanceof ArkYieldInst) {
        return sourceNode(letAssign(inst.id, `yield ${inst.argId.description}`))
      } else if (inst instanceof ArkReturnInst) {
        return sourceNode(`return ${inst.argId.description}\n`)
      } else if (inst instanceof ArkLetCopyInst) {
        return sourceNode(letAssign(inst.id, inst.argId.description!))
      } else if (inst instanceof ArkCallInst) {
        return sourceNode(letAssign(inst.id, `yield* ${inst.fnId.description}.body(${inst.argIds.map((id) => id.description).join(', ')})`))
      } else if (inst instanceof ArkInvokeInst) {
        return sourceNode(letAssign(inst.id, `yield* ${inst.objId.description}.getMethod('${inst.prop}').body(${inst.objId.description}, ${inst.argIds.map((id) => id.description).join(', ')})`))
      } else if (inst instanceof ArkSetNamedLocInst) {
        return sourceNode([
          `if (${jsMangle(inst.lexpId.description!)} !== ArkUndefined && ${jsMangle(inst.lexpId.description!)}.constructor !== ArkNullVal && ${inst.valId.description}.constructor !== ${jsMangle(inst.lexpId.description!)}.constructor) {\n`,
          'throw new JsRuntimeError(\'Assignment to different type\')\n',
          '}\n',
          letAssign(inst.id, `${jsMangle(inst.lexpId.description!)} = ${inst.valId.description}`),
        ])
      } else if (inst instanceof ArkSetPropertyInst) {
        return sourceNode(letAssign(inst.id, `${inst.lexpId.description}.set('${inst.prop}', ${inst.valId.description})`))
      } else if (inst instanceof ArkObjectLiteralInst) {
        const objInits: string[] = []
        for (const [k, v] of inst.properties.entries()) {
          objInits.push(`[${util.inspect(k)}, ${v.description}]`)
        }
        return sourceNode(letAssign(inst.id, `new ArkObject(new Map([${objInits.join(', ')}]))`))
      } else if (inst instanceof ArkListLiteralInst) {
        return sourceNode(letAssign(inst.id, `new ArkList([${inst.valIds.map((id) => id.description).join(', ')}])`))
      } else if (inst instanceof ArkMapLiteralInst) {
        const mapInits: string[] = []
        for (const [k, v] of inst.map.entries()) {
          mapInits.push(`[${k.description}, ${v.description}]`)
        }
        return sourceNode(letAssign(inst.id, `new ArkMap(new Map([${mapInits.join(', ')}]))`))
      } else if (inst instanceof ArkPropertyInst) {
        return sourceNode([
          letAssign(inst.id, `${inst.objId.description}.get('${inst.prop}')`),
          `if (${inst.id.description} === ArkUndefined) throw new JsRuntimeError('Invalid property')\n`,
        ])
      } else if (inst instanceof ArkCaptureInst) {
        return sourceNode(letAssign(inst.id, jsMangle(inst.name)))
      } else if (inst instanceof ArkLocalInst) {
        return sourceNode(letAssign(inst.id, jsMangle(inst.name)))
      } else {
        console.log('Invalid ArkInst:')
        debug(inst)
        throw new Error('invalid ArkInst')
      }
    }

    const [line, col] = sourceLocToLineAndCol(
      insts.insts.length > 0 ? insts.insts[0].sourceLoc : undefined,
    )
    return new SourceNode(line, col, file, insts.insts.map((inst) => instToJs(inst)))
  }

  const sourceNode = new SourceNode(1, 1, 'src/ursa/flat-to-js.ts', [
    '"use strict";\n',
    '(function* () {\n',
    instsToJs(insts),
    `return ${insts.id.description}\n})`,
  ])
  const jsCode = sourceNode.toStringWithSourceMap({file: file ?? undefined})
  if (process.env.DEBUG) {
    console.log(prettier.format(jsCode.code, {parser: 'babel'}))
  }
  return jsCode
}

export function arkToJs(exp: ArkExp, file: string | null = null): CodeWithSourceMap {
  const insts = expToInsts(exp)
  return flatToJs(insts, file)
}

export async function evalArkJs(source: CodeWithSourceMap | string, file = '(Compiled Ark)'): Promise<ArkVal> {
  let jsSource: string
  if (typeof source === 'string') {
    jsSource = source
  } else {
    const urlString = `data:application/json;base64,${Buffer.from(source.map.toString()).toString('base64')}`
    jsSource = `${source.code}\n//# sourceMappingURL=${urlString}\n//# sourceURL=${path.basename(file)}`
    // Useful for debugging stack trace
    // fs.writeFileSync('tmp.js', source.code)
    // jsSource = `${source.code}\n//# sourceURL=tmp.js`
  }
  try {
    // eslint-disable-next-line no-eval
    const gen = eval(jsSource) as () => Operation<ArkVal>
    return await run<ArkVal>(gen)
  } catch (e) {
    assert(e instanceof Error)
    const dirtyStack = new UrsaStackTracey(e).withSources()
    // Useful for debugging stack trace
    // debug(dirtyStack.items.map((i) => `${i.file} ${i.line}:${i.column}:${i.sourceLine}`), null)
    const stack = dirtyStack.clean()
    const newError = new JsRuntimeError('')
    const trace = []
    let message = e.message
    if (stack.items.length > 0) {
      const curFrame = stack.items[0]
      let prefix: string
      if (curFrame.line !== undefined) {
        if (message.match('yield\\* \\(intermediate value\\)')
          || message.match("Cannot read properties of undefined \\(reading 'body'\\)")) {
          const index = curFrame.column! - 1
          if (curFrame.sourceLine !== undefined && index < curFrame.sourceLine.length) {
            if (curFrame.sourceLine[index + 1] === '(') {
              message = 'Invalid call'
            } else if (curFrame.sourceLine[index + 1] === '.') {
              message = 'Invalid method'
            } else {
              console.log(curFrame.sourceLine)
            }
          }
        } else {
          console.log(message)
        }
        prefix = `Line ${curFrame.line}, col ${curFrame.column}:`
        const lineNumWidth = (curFrame.line + 1).toString().length
        const fileSource = getSource(file)
        if (curFrame.line > 1) {
          prefix += `\n  ${(curFrame.line - 1).toString().padStart(lineNumWidth, ' ')} | ${fileSource.resolve({line: curFrame.line - 1, column: 1}).sourceLine}`
        }
        prefix += `\n> ${curFrame.line.toString().padStart(lineNumWidth, ' ')} | ${curFrame.sourceLine}\n${' '.repeat(curFrame.column! + lineNumWidth + 4)}^`
        if (curFrame.line < fileSource.lines.length) {
          prefix += `\n  ${(curFrame.line + 1).toString()} | ${fileSource.resolve({line: curFrame.line + 1, column: 1}).sourceLine}\n`
        }
      } else {
        prefix = '(unknown location)'
      }
      newError.message = `${prefix}\n${message}`
      let consumer
      if (typeof source !== 'string') {
        consumer = await new SourceMapConsumer(source.map.toJSON())
      }
      for (const [i, frame] of stack.items.slice(1).entries()) {
        let fnLocation
        if (i === stack.items.length - 2) {
          fnLocation = 'at top level'
        } else {
          let fnName = '(anonymous function)'
          if (consumer) {
            const generatedPosition = consumer.generatedPositionFor({
              source: path.normalize(file),
              line: frame.line!,
              column: frame.column!,
            })
            if (generatedPosition.line !== null) {
              const origPosition = consumer.originalPositionFor(generatedPosition as Position)
              if (origPosition.name !== null) {
                fnName = origPosition.name
              }
            }
          }
          fnLocation = `in ${fnName}`
        }
        if (frame.line !== undefined) {
          trace.push(`line ${frame.line}\n    ${frame.sourceLine}, ${fnLocation}`)
        } else {
          trace.push('(uninstrumented stack frame)')
        }
      }
      if (consumer) {
        consumer.destroy()
      }
    }
    if (trace.length > 0) {
      newError.message += `

Traceback (most recent call last)
${trace.map((s) => `  ${s}`).join('\n')}`
    }
    throw newError
  }
}
