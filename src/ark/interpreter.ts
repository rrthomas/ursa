// Interpreter for flattened Ark.
// © Reuben Thomas 2023-2024
// Released under the MIT license.

import {Interval} from 'ohm-js'

import {
  ArkAwaitInst, ArkBlockCloseInst, ArkBlockOpenInst, ArkBreakInst, ArkCallableBlockOpenInst,
  ArkCallInst, ArkCaptureInst, ArkContinueInst, ArkElseBlockCloseInst, ArkElseBlockInst,
  ArkFnBlockOpenInst, ArkGeneratorBlockOpenInst, ArkIfBlockOpenInst, ArkInst,
  ArkLaunchBlockCloseInst, ArkLaunchBlockOpenInst, ArkLetBlockCloseInst, ArkLetBlockOpenInst,
  ArkLetCopyInst, ArkListLiteralInst, ArkLiteralInst, ArkLocalInst, ArkLoopBlockCloseInst,
  ArkLoopBlockOpenInst, ArkMapLiteralInst, ArkObjectLiteralInst, ArkPropertyInst, ArkReturnInst,
  ArkSetCaptureInst, ArkSetLocalInst, ArkSetNamedLocInst, ArkSetPropertyInst, ArkYieldInst,
} from './flatten.js'
import {
  ArkAbstractObjectBase, ArkBoolean, ArkList, ArkMap, ArkNull, ArkNullVal,
  ArkObject, ArkPromise, ArkUndefined, ArkVal, NativeAsyncFn, NativeFn,
  ArkRef, ArkValRef,
} from './data.js'
import {
  ArkCapture, ArkContinuation, ArkFlatClosure, ArkFlatGeneratorClosure,
  ArkLocal, ArkNamedLoc,
} from './code.js'
import {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  debug,
} from './util.js'

// Each stack frame consists of a tuple of local vars, captures, and
// debug info.
class ArkFrame {
  constructor(
    public locals: ArkRef[] = [],
    public captures: ArkRef[] = [],
    public memory: Map<symbol, ArkVal> = new Map(),
    public debug = new ArkFrameDebugInfo(),
  ) {}
}

class ArkFrameDebugInfo {
  constructor(
    public callerName?: string,

    public sourceLoc?: Interval,
  ) {}
}

export class ArkState {
  public continuation?: ArkContinuation

  public loopStack: ArkBlockOpenInst[] = []

  constructor(
    public inst?: ArkInst,
    public readonly frame = new ArkFrame(),
    public outerState?: ArkState,
  ) {}

  push(items: ArkRef[]) {
    this.frame.locals.push(...items)
    return this
  }

  pop(nItems: number) {
    for (let i = 0; i < nItems; i += 1) {
      this.frame.locals.pop()
    }
  }

  async run(): Promise<ArkVal> {
    return evalFlat(this)
  }
}

export class ArkRuntimeError extends Error {
  constructor(
    public ark: ArkState,
    public message: string,
    public sourceLoc: unknown,
  ) {
    super()
  }
}

function evalRef(frame: ArkFrame, lexp: ArkNamedLoc): ArkRef {
  if (lexp instanceof ArkLocal) {
    return frame.locals[lexp.index]
  } else if (lexp instanceof ArkCapture) {
    return frame.captures[lexp.index]
  }
  throw new Error('invalid ArkNamedLoc')
}

function makeLocals(names: string[], vals: ArkVal[]): ArkRef[] {
  const locals: ArkValRef[] = names.map((_val, index) => new ArkValRef(vals[index] ?? ArkUndefined))
  if (vals.length > names.length) {
    locals.push(...vals.slice(names.length).map((val) => new ArkValRef(val)))
  }
  return locals
}

async function evalFlat(outerArk: ArkState): Promise<ArkVal> {
  let ark: ArkState | undefined = outerArk
  let inst = ark.inst
  let prevInst
  while (inst !== undefined) {
    prevInst = inst
    const mem: Map<symbol, ArkVal> = ark.frame.memory
    if (inst instanceof ArkLiteralInst) {
      mem.set(inst.id, inst.val)
      inst = inst.next
    } else if (inst instanceof ArkLetCopyInst) {
      mem.set(inst.id, mem.get(inst.argId)!)
      inst = inst.next
    } else if (inst instanceof ArkLaunchBlockCloseInst) {
      const result = mem.get(inst.blockId)!
      mem.set(inst.id, result)
      return result
    } else if (inst instanceof ArkElseBlockInst) {
      mem.set(inst.id, mem.get(inst.ifBlockId)!)
      inst = inst.matchingClose.next
    } else if (inst instanceof ArkLoopBlockCloseInst) {
      inst = inst.matchingOpen.next
    } else if (inst instanceof ArkElseBlockCloseInst) {
      const result = mem.get(inst.blockId)!
      mem.set(inst.matchingOpen.id, result)
      mem.set(inst.id, result)
      inst = inst.next
    } else if (inst instanceof ArkLetBlockCloseInst) {
      mem.set(inst.id, mem.get(inst.blockId)!)
      // Pop locals introduced in this block.
      ark.pop((inst.matchingOpen as ArkLetBlockOpenInst).vars.length)
      inst = inst.next
    } else if (inst instanceof ArkBlockCloseInst) {
      mem.set(inst.id, mem.get(inst.blockId)!)
      inst = inst.next
    } else if (inst instanceof ArkIfBlockOpenInst) {
      const result = mem.get(inst.condId)!
      mem.set(inst.id, result)
      if (result !== ArkBoolean(false)) {
        inst = inst.next
      } else {
        inst = inst.matchingClose.next
      }
    } else if (inst instanceof ArkLoopBlockOpenInst) {
      ark.loopStack.unshift(inst)
      inst = inst.next
    } else if (inst instanceof ArkLaunchBlockOpenInst) {
      const innerArk = new ArkState(
        inst.next,
        new ArkFrame(
          [...ark.frame.locals],
          [...ark.frame.captures],
          new Map(ark.frame.memory.entries()),
          ark.frame.debug,
        ),
        ark.outerState,
      )
      const result = Promise.resolve(new ArkPromise(evalFlat(innerArk)))
      mem.set(inst.id, result)
      // The Promise becomes the result of the entire block.
      mem.set(inst.matchingClose.id, result)
      inst = inst.matchingClose.next
    } else if (inst instanceof ArkCallableBlockOpenInst) {
      const captures = []
      for (const v of inst.capturedVars) {
        captures.push(evalRef(ark.frame, v))
      }
      let Constructor
      if (inst instanceof ArkFnBlockOpenInst) {
        Constructor = ArkFlatClosure
      } else if (inst instanceof ArkGeneratorBlockOpenInst) {
        Constructor = ArkFlatGeneratorClosure
      } else {
        throw new Error('invalid ArkCallableBlockOpenInst')
      }
      const result = new Constructor(inst.params, captures, inst.next!)
      mem.set(inst.matchingClose.id, result)
      inst = inst.matchingClose.next
    } else if (inst instanceof ArkLetBlockOpenInst) {
      ark.push(makeLocals(inst.vars, []))
      inst = inst.next
    } else if (inst instanceof ArkBlockOpenInst) {
      inst = inst.next
    } else if (inst instanceof ArkAwaitInst) {
      const promise = (mem.get(inst.argId)! as ArkPromise).promise
      mem.set(inst.id, await promise)
      inst = inst.next
    } else if (inst instanceof ArkBreakInst) {
      const result = mem.get(inst.argId)!
      mem.set(inst.id, result)
      mem.set(inst.loopInst.matchingClose.id, result)
      const nPops = ark.frame.locals.length - inst.loopInst.localsDepth
      ark.pop(nPops)
      inst = ark.loopStack.shift()!.matchingClose.next
    } else if (inst instanceof ArkContinueInst) {
      mem.set(inst.id, ArkNull())
      const nPops = ark.frame.locals.length - inst.loopInst.localsDepth
      ark.pop(nPops)
      inst = ark.loopStack[0]
    } else if (inst instanceof ArkYieldInst) {
      const result = mem.get(inst.argId)!
      ark.inst = inst
      if (ark.outerState === undefined || ark.continuation === undefined) {
        throw new ArkRuntimeError(ark, 'yield outside a generator', inst.sourceLoc)
      }
      ark = ark.outerState
      const caller = ark.inst!
      inst = caller.next
      prevInst = caller
      ark.frame.memory.set(caller.id, result)
    } else if (inst instanceof ArkReturnInst) {
      const result = mem.get(inst.argId)!
      if (ark.continuation !== undefined) {
        // If we're in a generator, end it.
        ark.continuation.done = true
      }
      ark = ark.outerState
      if (ark === undefined) {
        return result
      }
      const caller = ark.inst!
      inst = caller.next
      prevInst = caller
      ark.frame.memory.set(caller.id, result)
    } else if (inst instanceof ArkCallInst) {
      const args = inst.argIds.map((id) => mem.get(id)!)
      const callable: ArkVal = mem.get(inst.fnId)!
      if (callable instanceof ArkFlatGeneratorClosure) {
        const result = new ArkContinuation(new ArkState(
          callable.body,
          new ArkFrame(
            makeLocals(callable.params, inst.argIds.map((id) => mem.get(id)!)),
            callable.captures,
            new Map(),
            new ArkFrameDebugInfo(inst.name, inst.sourceLoc),
          ),
          ark,
        ))
        mem.set(inst.id, result)
        inst = inst.next
      } else if (callable instanceof ArkFlatClosure) {
        ark.inst = inst
        ark = new ArkState(
          callable.body,
          new ArkFrame(
            makeLocals(callable.params, inst.argIds.map((id) => mem.get(id)!)),
            callable.captures,
            new Map(),
            new ArkFrameDebugInfo(inst.name, inst.sourceLoc),
          ),
          ark,
        )
        inst = ark.inst
      } else if (callable instanceof ArkContinuation) {
        if (callable.done) {
          mem.set(inst.id, ArkNull())
          inst = inst.next
        } else {
          callable.state.frame.memory.set(callable.state.inst!.id, mem.get(inst.argIds[0])!)
          ark.inst = inst
          callable.state.outerState = ark
          ark = callable.state
          if (ark.continuation === undefined && inst.argIds.length > 0) {
            throw new ArkRuntimeError(ark, 'No argument allowed to initial generator invocation', inst.sourceLoc)
          }
          ark.continuation = callable
          inst = ark.inst
          // If we're resuming, 'inst' pointed to the ArkYieldInst so we can
          // set its result, so we need to advance to the next instruction.
          if (inst instanceof ArkYieldInst) {
            inst = inst.next
          }
        }
      } else if (callable instanceof NativeFn) {
        mem.set(inst.id, callable.body(...args))
        inst = inst.next
      } else if (callable instanceof NativeAsyncFn) {
        mem.set(inst.id, await callable.body(...args))
        inst = inst.next
      } else {
        throw new ArkRuntimeError(ark, 'Invalid call', inst.sourceLoc)
      }
    } else if (inst instanceof ArkSetNamedLocInst) {
      const result = mem.get(inst.valId)!
      let ref: ArkRef
      if (inst instanceof ArkSetCaptureInst) {
        ref = ark.frame.captures[inst.lexpIndex]
      } else if (inst instanceof ArkSetLocalInst) {
        ref = ark.frame.locals[inst.lexpIndex]
      } else {
        throw new Error('invalid ArkSetNamedLocInst')
      }
      const oldVal = ref.get()
      if (
        oldVal !== ArkUndefined
        && oldVal.constructor !== ArkNullVal
        && oldVal.constructor !== result.constructor) {
        throw new ArkRuntimeError(ark, 'Assignment to different type', inst.sourceLoc)
      }
      mem.set(inst.id, result)
      ref.set(result)
      inst = inst.next
    } else if (inst instanceof ArkSetPropertyInst) {
      const result = mem.get(inst.valId)!
      const obj = mem.get(inst.lexpId)! as ArkObject
      if (obj.get(inst.prop) === ArkUndefined) {
        throw new ArkRuntimeError(ark, 'Invalid property', inst.sourceLoc)
      }
      obj.set(inst.prop, result)
      mem.set(inst.id, result)
      inst = inst.next
    } else if (inst instanceof ArkObjectLiteralInst) {
      const properties = new Map<string, ArkVal>()
      for (const [k, v] of inst.properties) {
        properties.set(k, mem.get(v)!)
      }
      mem.set(inst.id, new ArkObject(properties))
      inst = inst.next
    } else if (inst instanceof ArkListLiteralInst) {
      mem.set(inst.id, new ArkList(inst.valIds.map((id) => mem.get(id)!)))
      inst = inst.next
    } else if (inst instanceof ArkMapLiteralInst) {
      const map = new Map<ArkVal, ArkVal>()
      for (const [k, v] of inst.map) {
        map.set(mem.get(k)!, mem.get(v)!)
      }
      mem.set(inst.id, new ArkMap(map))
      inst = inst.next
    } else if (inst instanceof ArkPropertyInst) {
      const obj = mem.get(inst.objId)!
      if (!(obj instanceof ArkAbstractObjectBase)) {
        throw new ArkRuntimeError(ark, 'Invalid object', inst.sourceLoc)
      }
      const result = obj.get(inst.prop)
      if (result === ArkUndefined) {
        throw new ArkRuntimeError(ark, 'Invalid property', inst.sourceLoc)
      }
      mem.set(inst.id, result)
      inst = inst.next
    } else if (inst instanceof ArkCaptureInst) {
      const capture = ark.frame.captures[inst.index].get()
      if (capture === undefined) {
        throw new Error('undefined capture')
      }
      mem.set(inst.id, capture)
      inst = inst.next
    } else if (inst instanceof ArkLocalInst) {
      const local = ark.frame.locals[inst.index].get()
      if (local === undefined) {
        throw new Error('undefined local')
      }
      mem.set(inst.id, local)
      inst = inst.next
    } else {
      throw new Error('invalid ArkInst')
    }
  }
  return prevInst ? ark.frame.memory.get(prevInst.id)! : ArkUndefined
}

export async function pushLets(ark: ArkState, boundVars: [string, ArkInst][]) {
  const lets = makeLocals(boundVars.map((bv) => bv[0]), [])
  ark.push(lets)
  const vals: ArkVal[] = []
  for (const bv of boundVars) {
    ark.inst = bv[1]
    vals.push(await evalFlat(ark))
  }
  for (let i = 0; i < lets.length; i += 1) {
    lets[i].set(vals[i])
  }
  return lets.length
}

export async function callFlat(callable: ArkFlatClosure, locals: ArkValRef[]): Promise<ArkVal> {
  const ark = new ArkState(callable.body, new ArkFrame(locals, callable.captures))
  return evalFlat(ark)
}
