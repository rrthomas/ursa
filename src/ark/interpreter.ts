// Ark interpreter.
// © Reuben Thomas 2023-2024
// Released under the MIT license.

import assert from 'assert'
import util from 'util'

import programVersion from '../version.js'
import {fromJs, toJs} from './ffi.js'
import {FsMap} from './fsmap.js'

class Namespace<T extends ArkVal> extends Map<string, T> {
  constructor(inits: [string, T][]) {
    super(inits)
    for (const [name, val] of inits) {
      Namespace.setName(name, val)
    }
  }

  private static setName(name: string, val: ArkVal) {
    if (!(val instanceof ArkConcreteVal)) {
      val.debug.name = name
    }
  }

  set(name: string, val: T) {
    Namespace.setName(name, val)
    super.set(name, val)
    return this
  }
}

// Each stack frame consists of a tuple of local vars, captures, and
// debug info.
export class ArkFrame {
  constructor(
    public locals: ArkRef[] = [],
    public captures: ArkRef[] = [],
    public debug = new ArkFrameDebugInfo(),
  ) {}
}

export class ArkFrameDebugInfo {
  constructor(
    public name: ArkRef | undefined = undefined,
    public source: ArkCall | undefined = undefined,
  ) {}
}

export class ArkState {
  constructor(
    public readonly frame = new ArkFrame(),
    public readonly outerState?: ArkState,
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

  async run(compiledVal: ArkExp): Promise<ArkVal> {
    return compiledVal.eval(this)
  }
}

export class ArkRuntimeError extends Error {
  sourceLoc: unknown

  constructor(public ark: ArkState, public message: string, public val: Ark) {
    super()
    this.sourceLoc = val.debug.sourceLoc
  }
}

// Base class for compiled code.
export class Ark {
  static nextId = 0

  static debugEnumerable = process.env.DEBUG_ARK !== undefined

  constructor() {
    Object.defineProperty(this, 'debug', {enumerable: Ark.debugEnumerable})
    this.debug.uid = Ark.nextId
    Ark.nextId += 1
  }

  debug = new ArkDebugInfo()
}

class ArkDebugInfo {
  uid: number | undefined

  name: string | undefined

  sourceLoc: unknown

  env: string | undefined
}

export class ArkVal extends Ark {
  constructor() {
    super()
    // Make this class incompatible with ArkExp.
    Object.defineProperty(this, '_arkval', {enumerable: false})
  }

  _arkval: undefined
}

export abstract class ArkExp extends Ark {
  abstract eval(ark: ArkState): Promise<ArkVal>
}

export class ArkLiteral extends ArkExp {
  constructor(public val: ArkVal = ArkNull()) {
    super()
  }

  eval(_ark: ArkState): Promise<ArkVal> {
    return Promise.resolve(this.val)
  }
}

abstract class ArkAbstractObjectBase extends ArkVal {
  abstract get(prop: string): ArkVal

  abstract set(prop: string, val: ArkVal): ArkVal
}

export class ArkObjectBase extends ArkAbstractObjectBase {
  constructor(public properties: Map<string, ArkVal> = new Map()) {
    super()
  }

  get(prop: string) {
    return this.properties.get(prop) ?? ArkUndefined
  }

  set(prop: string, val: ArkVal) {
    this.properties.set(prop, val)
    return val
  }
}

export abstract class ArkConcreteVal<T> extends ArkObjectBase {
  constructor(public val: T) {
    super()
  }
}

export class ArkNullVal extends ArkConcreteVal<null> {}
export class ArkBooleanVal extends ArkConcreteVal<boolean> {}
export class ArkNumberVal extends ArkConcreteVal<number> {}
export class ArkStringVal extends ArkConcreteVal<string> {
  constructor(val: string) {
    super(val)
    this.properties = new Map([
      ['get', new NativeFn(['index'], (index: ArkVal) => ArkString(this.val[toJs(index) as number]))],
      ['iter', new NativeFn([], () => {
        const str = this.val
        const generator = (function* stringGenerator() {
          for (const elem of str) {
            yield ArkString(elem)
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
    ])
  }
}

class ConcreteInterned {
  constructor() {
    throw new Error('use ConcreteInterned.create, not constructor')
  }

  private static intern: Map<unknown, WeakRef<ArkConcreteVal<unknown>>> = new Map()

  private static registry: FinalizationRegistry<unknown> = new FinalizationRegistry(
    (key) => this.intern.delete(key),
  )

  static value<T extends ArkConcreteVal<U>, U>(TConstructor: new (val: U) => T, rawVal: U): T {
    let ref = ConcreteInterned.intern.get(rawVal)
    let val: T
    if (ref === undefined || ref.deref() === undefined) {
      val = new TConstructor(rawVal)
      ref = new WeakRef(val)
      ConcreteInterned.intern.set(rawVal, ref)
      ConcreteInterned.registry.register(val, rawVal, val)
    } else {
      val = ref.deref()! as T
    }
    return val
  }
}

export const ArkUndefined = new ArkVal()
ArkUndefined.debug.name = 'Undefined'
export function ArkNull() {
  return ConcreteInterned.value<ArkNullVal, null>(ArkNullVal, null)
}
export function ArkBoolean(b: boolean) {
  return ConcreteInterned.value<ArkBooleanVal, boolean>(ArkBooleanVal, b)
}
export function ArkNumber(n: number) {
  return ConcreteInterned.value<ArkNumberVal, number>(ArkNumberVal, n)
}
export function ArkString(s: string) {
  return ConcreteInterned.value<ArkStringVal, string>(ArkStringVal, s)
}

export class ArkNonLocalReturn extends Error {
  constructor(public readonly val: ArkVal = ArkNull()) {
    super()
  }
}

export class ArkBreakException extends ArkNonLocalReturn {}
export class ArkContinueException extends ArkNonLocalReturn {}
export class ArkReturnException extends ArkNonLocalReturn {}

export class ArkBreak extends ArkExp {
  constructor(public exp: ArkExp = new ArkLiteral(ArkNull())) {
    super()
  }

  async eval(ark: ArkState): Promise<never> {
    throw new ArkBreakException(await this.exp.eval(ark))
  }
}

export class ArkContinue extends ArkExp {
  // eslint-disable-next-line class-methods-use-this
  eval(_ark: ArkState): Promise<never> {
    throw new ArkContinueException()
  }
}

export class ArkReturn extends ArkExp {
  constructor(public exp: ArkExp = new ArkLiteral(ArkNull())) {
    super()
  }

  async eval(ark: ArkState): Promise<never> {
    throw new ArkReturnException(await this.exp.eval(ark))
  }
}

function makeLocals(names: string[], vals: ArkVal[]): ArkRef[] {
  const locals: ArkValRef[] = names.map((_val, index) => new ArkValRef(vals[index] ?? ArkUndefined))
  if (vals.length > names.length) {
    locals.push(...vals.slice(names.length).map((val) => new ArkValRef(val)))
  }
  return locals
}

abstract class ArkCallable extends ArkVal {
  constructor(public params: string[], public captures: ArkRef[]) {
    super()
  }

  abstract call(ark: ArkState): Promise<ArkVal>
}

export class ArkClosure extends ArkCallable {
  constructor(params: string[], captures: ArkRef[], public body: ArkExp) {
    super(params, captures)
  }

  async call(ark: ArkState): Promise<ArkVal> {
    try {
      return await this.body.eval(ark)
    } catch (e) {
      if (!(e instanceof ArkReturnException)) {
        throw e
      }
      return e.val
    }
  }
}

export class NativeFn extends ArkCallable {
  constructor(params: string[], public body: (...args: ArkVal[]) => ArkVal) {
    super(params, [])
  }

  async call(ark: ArkState): Promise<ArkVal> {
    const args = ark.frame.locals.map((ref) => ref.get(ark))
    return Promise.resolve(this.body(...args))
  }
}

export class NativeAsyncFn extends ArkCallable {
  constructor(params: string[], public body: (...args: ArkVal[]) => Promise<ArkVal>) {
    super(params, [])
  }

  async call(ark: ArkState): Promise<ArkVal> {
    const args = ark.frame.locals.map((ref) => ref.get(ark))
    return this.body(...args)
  }
}

export class ArkFn extends ArkExp {
  constructor(public params: string[], public capturedVars: ArkLexp[], public body: ArkExp) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const captures = []
    for (const exp of this.capturedVars) {
      // eslint-disable-next-line no-await-in-loop
      captures.push(await exp.evalRef(ark))
    }
    return new ArkClosure(this.params, captures, this.body)
  }
}

// export class ArkType extends Ark {
//   constructor(
//     public superTraits: ArkType[],
//     public members: Map<string, ArkFieldType | ArkMethodType>,
//   ) {
//     super()
//   }
// }

// export class ArkFieldType extends Ark {
//   constructor(public var_: boolean, public type: ArkType) {
//     super()
//   }
// }

// export class ArkMethodType extends Ark {
//   constructor(public params: [string, ArkType][], public returnType: ArkType) {
//     super()
//   }
// }

export class ArkCall extends ArkExp {
  constructor(public fn: ArkExp, public args: ArkExp[]) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const fn = this.fn
    let sym: ArkRef | undefined
    if (fn instanceof ArkLocal || fn instanceof ArkCapture) {
      sym = await fn.evalRef(ark)
    }
    const fnVal = await fn.eval(ark)
    if (!(fnVal instanceof ArkCallable)) {
      throw new ArkRuntimeError(ark, 'Invalid call', this)
    }
    const evaluatedArgs = []
    for (const arg of this.args) {
      // eslint-disable-next-line no-await-in-loop
      evaluatedArgs.push(await arg.eval(ark))
    }
    const locals = makeLocals(fnVal.params, evaluatedArgs)
    const debugInfo = new ArkFrameDebugInfo(sym, this)
    return fnVal.call(new ArkState(new ArkFrame(locals, fnVal.captures, debugInfo), ark))
  }
}

export abstract class ArkRef extends Ark {
  abstract get(ark: ArkState): ArkVal

  abstract set(ark: ArkState, val: ArkVal): ArkVal
}

export class ArkValRef extends ArkRef {
  constructor(public val: ArkVal = ArkNull()) {
    super()
  }

  get(_ark: ArkState): ArkVal {
    return this.val
  }

  set(_ark: ArkState, val: ArkVal): ArkVal {
    this.val = val
    return val
  }
}

export abstract class ArkLexp extends ArkExp {
  async eval(ark: ArkState): Promise<ArkVal> {
    return (await this.evalRef(ark)).get(ark)
  }

  abstract evalRef(ark: ArkState): Promise<ArkRef>
}

export class ArkLocal extends ArkLexp {
  constructor(public index: number) {
    super()
  }

  evalRef(ark: ArkState): Promise<ArkRef> {
    return Promise.resolve(ark.frame.locals[this.index])
  }
}

export class ArkCapture extends ArkLexp {
  constructor(public index: number) {
    super()
  }

  evalRef(ark: ArkState): Promise<ArkRef> {
    return Promise.resolve(ark.frame.captures[this.index])
  }
}

export class ArkSet extends ArkExp {
  constructor(public lexp: ArkLexp, public exp: ArkExp) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const ref = await this.lexp.evalRef(ark)
    const res = await this.exp.eval(ark)
    const oldVal = ref.get(ark)
    if (oldVal !== ArkUndefined
      && oldVal.constructor !== ArkNullVal
      && res.constructor !== oldVal.constructor) {
      throw new ArkRuntimeError(ark, 'Assignment to different type', this)
    }
    ref.set(ark, res)
    return res
  }
}

export class ArkObject extends ArkObjectBase {}

export class ArkObjectLiteral extends ArkExp {
  constructor(public properties: Map<string, ArkExp>) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const inits = new Map<string, ArkVal>()
    for (const [k, v] of this.properties) {
      // eslint-disable-next-line no-await-in-loop
      inits.set(k, await v.eval(ark))
    }
    return new ArkObject(inits)
  }
}

export class NativeObject extends ArkAbstractObjectBase {
  constructor(public obj: object) {
    super()
  }

  get(prop: string): ArkVal {
    return fromJs((this.obj as {[key: string]: unknown})[prop], this.obj) ?? ArkUndefined
  }

  set(prop: string, val: ArkVal) {
    (this.obj as {[key: string]: unknown})[prop] = toJs(val)
    return val
  }
}

export class ArkProperty extends ArkLexp {
  constructor(public obj: ArkExp, public prop: string) {
    super()
  }

  async evalRef(ark: ArkState): Promise<ArkRef> {
    const obj = await this.obj.eval(ark)
    if (!(obj instanceof ArkAbstractObjectBase)) {
      throw new ArkRuntimeError(ark, 'Attempt to read property of non-object', this)
    }
    const ref = new ArkPropertyRef(obj, this.prop)
    ref.debug.sourceLoc = this.debug.sourceLoc
    return ref
  }
}

export class ArkPropertyRef extends ArkRef {
  constructor(public obj: ArkAbstractObjectBase, public prop: string) {
    super()
  }

  get(ark: ArkState) {
    const val = this.obj.get(this.prop)
    if (val === ArkUndefined) {
      throw new ArkRuntimeError(ark, `Invalid property '${this.prop}'`, this)
    }
    return val
  }

  set(_ark: ArkState, val: ArkVal) {
    this.obj.set(this.prop, val)
    return val
  }
}

export class ArkList extends ArkObjectBase {
  constructor(public list: ArkVal[]) {
    super(new Map([
      ['len', new NativeFn(['len'], () => ArkNumber(this.list.length))],
      ['get', new NativeFn(['index'], (index: ArkVal) => this.list[toJs(index) as number])],
      ['set', new NativeFn(
        ['index', 'val'],
        (index: ArkVal, val: ArkVal) => {
          this.list[toJs(index) as number] = val
          return this
        },
      )],
      ['push', new NativeFn(['item'], (item: ArkVal) => {
        this.list.push(item)
        return this
      })],
      ['pop', new NativeFn([], () => {
        this.list.pop()
        return this
      })],
      ['iter', new NativeFn([], () => {
        const list = this.list
        const generator = (function* listGenerator() {
          for (const elem of list) {
            yield elem
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
    ]))
  }
}

export class ArkListLiteral extends ArkExp {
  constructor(public list: ArkExp[]) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const evaluatedList = []
    for (const e of this.list) {
      // eslint-disable-next-line no-await-in-loop
      evaluatedList.push(await e.eval(ark))
    }
    return new ArkList(evaluatedList)
  }
}

export class ArkMap extends ArkObjectBase {
  constructor(public map: Map<ArkVal, ArkVal>) {
    super(new Map([
      ['set', new NativeFn(
        ['index', 'val'],
        (index: ArkVal, val: ArkVal) => {
          this.map.set(index, val)
          return this
        },
      )],
      ['get', new NativeFn(['index'], (index: ArkVal) => this.map.get(index) ?? ArkNull())],
      ['delete', new NativeFn(['index'], (index: ArkVal) => {
        this.map.delete(index)
        return this
      })],
      ['has', new NativeFn(['index'], (index: ArkVal) => ArkBoolean(this.map.has(index)))],
      ['iter', new NativeFn([], () => {
        const map = this.map
        const generator = (function* mapEntriesGenerator() {
          for (const [key, value] of map.entries()) {
            yield new ArkList([key, value])
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
      ['keys', new NativeFn([], () => {
        const map = this.map
        const generator = (function* mapKeysGenerator() {
          for (const key of map.keys()) {
            yield key
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
      ['values', new NativeFn([], () => {
        const map = this.map
        const generator = (function* mapValuesGenerator() {
          for (const value of map.values()) {
            yield value
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
    ]))
  }
}

export class ArkMapLiteral extends ArkExp {
  constructor(public map: Map<ArkExp, ArkExp>) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const evaluatedMap = new Map<ArkVal, ArkVal>()
    for (const [k, v] of this.map) {
      // eslint-disable-next-line no-await-in-loop
      evaluatedMap.set(await k.eval(ark), await v.eval(ark))
    }
    return new ArkMap(evaluatedMap)
  }
}

export async function pushLets(ark: ArkState, boundVars: [string, ArkExp][]) {
  const lets = makeLocals(boundVars.map((bv) => bv[0]), [])
  ark.push(lets)
  const vals: ArkVal[] = []
  for (const bv of boundVars) {
    // eslint-disable-next-line no-await-in-loop
    vals.push(await bv[1].eval(ark))
  }
  for (let i = 0; i < lets.length; i += 1) {
    lets[i].set(ark, vals[i])
  }
  return lets.length
}
export class ArkLet extends ArkExp {
  constructor(public boundVars: [string, ArkExp][], public body: ArkExp) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const nLets = await pushLets(ark, this.boundVars)
    let res: ArkVal
    try {
      res = await this.body.eval(ark)
    } catch (e) {
      if (e instanceof ArkNonLocalReturn) {
        ark.pop(nLets)
      }
      throw e
    }
    ark.pop(nLets)
    return res
  }
}

export class ArkSequence extends ArkExp {
  constructor(public exps: ArkExp[]) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    let res: ArkVal = ArkNull()
    for (const exp of this.exps) {
      // eslint-disable-next-line no-await-in-loop
      res = await exp.eval(ark)
    }
    return res
  }
}

export class ArkIf extends ArkExp {
  constructor(public cond: ArkExp, public thenExp: ArkExp, public elseExp?: ArkExp) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const condVal = await this.cond.eval(ark)
    let res: ArkVal
    if (toJs(condVal)) {
      res = await this.thenExp.eval(ark)
    } else {
      res = this.elseExp ? await this.elseExp.eval(ark) : ArkNull()
    }
    return res
  }
}

export class ArkAnd extends ArkExp {
  constructor(public left: ArkExp, public right: ArkExp) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const leftVal = await this.left.eval(ark)
    if (toJs(leftVal)) {
      // eslint-disable-next-line @typescript-eslint/return-await
      return await this.right.eval(ark)
    }
    return leftVal
  }
}

export class ArkOr extends ArkExp {
  constructor(public left: ArkExp, public right: ArkExp) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    const leftVal = await this.left.eval(ark)
    if (toJs(leftVal)) {
      return leftVal
    }
    // eslint-disable-next-line @typescript-eslint/return-await
    return await this.right.eval(ark)
  }
}

export class ArkLoop extends ArkExp {
  constructor(public body: ArkExp) {
    super()
  }

  async eval(ark: ArkState): Promise<ArkVal> {
    for (; ;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.body.eval(ark)
      } catch (e) {
        if (e instanceof ArkBreakException) {
          return e.val
        }
        if (!(e instanceof ArkContinueException)) {
          throw e
        }
      }
    }
  }
}

export const intrinsics = new Namespace([
  ['pos', new NativeFn(['val'], (val: ArkVal) => ArkNumber(+(toJs(val) as number)))],
  ['neg', new NativeFn(['val'], (val: ArkVal) => ArkNumber(-(toJs(val) as number)))],
  ['not', new NativeFn(['val'], (val: ArkVal) => ArkBoolean(!(toJs(val) as boolean)))],
  ['~', new NativeFn(['val'], (val: ArkVal) => ArkNumber(~(toJs(val) as number)))],
  ['=', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkBoolean(toJs(left) === toJs(right)))],
  ['!=', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkBoolean(toJs(left) !== toJs(right)))],
  ['<', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkBoolean((toJs(left) as number) < (toJs(right) as number)))],
  ['<=', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkBoolean((toJs(left) as number) <= (toJs(right) as number)))],
  ['>', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkBoolean((toJs(left) as number) > (toJs(right) as number)))],
  ['>=', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkBoolean((toJs(left) as number) >= (toJs(right) as number)))],
  ['+', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) + (toJs(right) as number)))],
  ['-', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) - (toJs(right) as number)))],
  ['*', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) * (toJs(right) as number)))],
  ['/', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) / (toJs(right) as number)))],
  ['%', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) % (toJs(right) as number)))],
  ['**', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) ** (toJs(right) as number)))],
  ['&', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) & (toJs(right) as number)))],
  ['|', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) | (toJs(right) as number)))],
  ['^', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) ^ (toJs(right) as number)))],
  ['<<', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) << (toJs(right) as number)))],
  ['>>', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) >> (toJs(right) as number)))],
  ['>>>', new NativeFn(['left', 'right'], (left: ArkVal, right: ArkVal) => ArkNumber((toJs(left) as number) >>> (toJs(right) as number)))],
])

export const globals = new ArkObject(new Map<string, ArkVal>([
  // Ursa's prelude (see also prelude.ursa).
  ['version', ArkString(programVersion)],
  ['debug', new NativeFn(['obj'], (obj: ArkVal) => {
    debug(obj)
    return ArkNull()
  })],
  ['fs', new NativeFn(['path'], (path: ArkVal) => new NativeObject(new FsMap(toJs(path) as string)))],

  // JavaScript bindings—imported libraries (with "use").
  ['js', new ArkObject(new Map([[
    'use', new NativeFn([], (arg: ArkVal) => {
      const name = toJs(arg)
      // eslint-disable-next-line max-len
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      return fromJs((globalThis as any)[name as string])
    }),
  ]]))],

  // JavaScript bindings—imported libraries (with "use").
  ['jslib', new ArkObject(new Map([[
    'use', new NativeAsyncFn([], async (...args: ArkVal[]) => {
      const importPath = (args.map(toJs).join('.'))
      const module: unknown = await import(importPath)
      assert(typeof module === 'object')
      const wrappedModule = new Map<string, ArkVal>()
      // eslint-disable-next-line guard-for-in
      for (const key in module) {
        wrappedModule.set(key, fromJs((module as {[key: string]: unknown})[key]))
      }
      return new ArkObject(wrappedModule)
    }),
  ]]))],
]))

export function valToString(x: unknown, depth: number | null = 1) {
  return util.inspect(
    x,
    {
      depth,
      colors: process.stdout && process.stdout.isTTY,
      sorted: true,
    },
  )
}

export function debug(x: unknown, depth?: number | null) {
  console.log(valToString(x, depth))
}
