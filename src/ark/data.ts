// Compiled Ark values.
// © Reuben Thomas 2023-2024
// Released under the MIT license.

import {
  action, call, Operation, Reject, Resolve, run, sleep,
} from 'effection'

import {FsMap} from './fsmap.js'
import programVersion from '../version.js'
import {debug} from './util.js'
import {ArkType, ArkTypedId} from './type.js'

// A hack that works for us, as browsers do not have util/types library, and
// is-generator-function doesn't play nice with rollup.
function isGeneratorFunction(obj: object) {
  const constructor = obj.constructor
  return constructor !== undefined && constructor.name === 'GeneratorFunction'
}

export class ArkVal {
  constructor(public type: ArkType) {}
}

export abstract class ArkAbstractObjectBase extends ArkVal {
  abstract getMethod(prop: string): ArkCallable | undefined

  abstract get(prop: string): ArkVal

  abstract set(prop: string, val: ArkVal): ArkVal
}

export class ArkCallable extends ArkVal {
  constructor(public params: string[]) {
    super(new ArkType([], new Map()))
  }
}

export class NativeFn extends ArkCallable {
  public body: (...args: ArkVal[]) => Operation<ArkVal>

  constructor(
    params: string[],
    innerBody: (...args: ArkVal[]) => ArkVal | Operation<ArkVal>,
  ) {
    super(params)
    if (isGeneratorFunction(innerBody)) {
      this.body = innerBody as (...args: ArkVal[]) => Operation<ArkVal>
    } else {
      // eslint-disable-next-line require-yield
      this.body = function* gen(...args: ArkVal[]) {
        return innerBody(...args)
      }
    }
  }
}

class ArkObjectBase extends ArkAbstractObjectBase {
  public properties: Map<string, ArkVal> = new Map()

  public static methods = new Map<string, ArkCallable>(
    [
      ['equals', new NativeFn(['right'], (thisVal, right) => ArkBoolean(thisVal === right))],
      ['notEquals', new NativeFn(['right'], (thisVal, right) => ArkBoolean(thisVal !== right))],
    ],
  )

  static addMethods(properties: [string, ArkCallable][]) {
    properties.forEach(([name, val]) => this.methods.set(name, val))
  }

  getMethod(prop: string): ArkCallable | undefined {
    return (this.constructor as typeof ArkObjectBase).methods.get(prop)
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
  static methods: Map<string, ArkCallable> = new Map([...ArkObjectBase.methods])

  static {
    ArkConcreteVal.addMethods(
      [
        ['equals', new NativeFn(['right'], (thisVal, right) => ArkBoolean((thisVal as ArkConcreteVal<unknown>).val === toJs(right)))],
        ['notEquals', new NativeFn(['right'], (thisVal, right) => ArkBoolean((thisVal as ArkConcreteVal<unknown>).val !== toJs(right)))],
      ],
    )
  }

  constructor(public val: T) {
    super()
  }
}

export class ArkNullVal extends ArkConcreteVal<null> {
  static methods: Map<string, ArkCallable> = new Map([...ArkConcreteVal.methods])

  constructor() {
    super(null)
  }
}
export class ArkBooleanVal extends ArkConcreteVal<boolean> {
  static methods: Map<string, ArkCallable> = new Map([...ArkConcreteVal.methods])

  static {
    ArkBooleanVal.addMethods([['not', new NativeFn([], (thisVal) => ArkBoolean(!(thisVal as ArkConcreteVal<boolean>).val))]])
  }
}
export class ArkNumberVal extends ArkConcreteVal<number> {
  static methods: Map<string, ArkCallable> = new Map([...ArkConcreteVal.methods])

  static {
    ArkNumberVal.addMethods(
      [
        ['toString', new NativeFn([], (thisVal) => ArkString((thisVal as ArkConcreteVal<number>).val.toString()))],
        ['pos', new NativeFn([], (thisVal) => ArkNumber(+(thisVal as ArkConcreteVal<number>).val))],
        ['neg', new NativeFn([], (thisVal) => ArkNumber(-(thisVal as ArkConcreteVal<number>).val))],
        ['bitwiseNot', new NativeFn([], (thisVal) => ArkNumber(~(thisVal as ArkConcreteVal<number>).val))],
        ['lt', new NativeFn(['right'], (thisVal, right) => ArkBoolean((thisVal as ArkConcreteVal<number>).val < (right as ArkNumberVal).val))],
        ['leq', new NativeFn(['right'], (thisVal, right) => ArkBoolean((thisVal as ArkConcreteVal<number>).val <= (right as ArkNumberVal).val))],
        ['gt', new NativeFn(['right'], (thisVal, right) => ArkBoolean((thisVal as ArkConcreteVal<number>).val > (right as ArkNumberVal).val))],
        ['geq', new NativeFn(['right'], (thisVal, right) => ArkBoolean((thisVal as ArkConcreteVal<number>).val >= (right as ArkNumberVal).val))],
        ['add', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val + (right as ArkNumberVal).val))],
        ['sub', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val - (right as ArkNumberVal).val))],
        ['mul', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val * (right as ArkNumberVal).val))],
        ['div', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val / (right as ArkNumberVal).val))],
        ['mod', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val % (right as ArkNumberVal).val))],
        ['exp', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val ** (right as ArkNumberVal).val))],
        ['bitwiseAnd', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val & (right as ArkNumberVal).val))],
        ['bitwiseOr', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val | (right as ArkNumberVal).val))],
        ['bitwiseXor', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val ^ (right as ArkNumberVal).val))],
        ['shiftLeft', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val << (right as ArkNumberVal).val))],
        ['shiftRight', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val >> (right as ArkNumberVal).val))],
        ['shiftRightArith', new NativeFn(['right'], (thisVal, right) => ArkNumber((thisVal as ArkConcreteVal<number>).val >>> (right as ArkNumberVal).val))],
      ],
    )
  }
}
export class ArkStringVal extends ArkConcreteVal<string> {
  static methods: Map<string, ArkCallable> = new Map([...ArkConcreteVal.methods])

  static {
    ArkStringVal.addMethods(
      [
        ['get', new NativeFn(['index'], (thisVal, index) => ArkString((thisVal as ArkConcreteVal<string>).val[toJs(index) as number]))],
        ['iter', new NativeFn([], (thisVal) => {
          const str = (thisVal as ArkConcreteVal<string>).val
          const generator = (function* stringGenerator() {
            for (const elem of str) {
              yield ArkString(elem)
            }
            return ArkNull()
          }())
          return new NativeFn([], () => generator.next().value)
        })],
        ['split', new NativeFn(['sep'], (thisVal, sep) => new ArkList((thisVal as ArkConcreteVal<string>).val.split((sep as ArkStringVal).val).map((s) => ArkString(s))))],
      ],
    )
  }
}

class ConcreteInterned {
  constructor() {
    throw new Error('use ConcreteInterned.value, not constructor')
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

export const ArkUndefined = new ArkVal(new ArkType([], new Map()))
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

export class ArkOperation extends ArkVal {
  constructor(public operation: Operation<ArkVal>) {
    super(new ArkType([], new Map())) // FIXME
  }
}

export abstract class ArkClosure extends ArkCallable {
  constructor(params: ArkTypedId[], returnType: ArkType, public captures: ArkRef[]) {
    super(params, returnType)
  }

  abstract call(locals: ArkValRef[]): Promise<ArkVal>
}
// ts-unused-exports:disable-next-line
export abstract class ArkGeneratorClosure extends ArkClosure {}

export class NativeOperation extends ArkCallable {
  constructor(params: ArkTypedId[], public body: (...args: ArkVal[]) => Operation<ArkVal>) {
    super(params, new ArkType([], new Map())) // FIXME: correct return type
  }
}

// ts-unused-exports:disable-next-line
export class NativeAsyncFn extends ArkCallable {
  public body: (...args: ArkVal[]) => Operation<ArkVal>

  constructor(
    params: ArkTypedId[],
    returnType: ArkType,
    innerBody: (...args: ArkVal[]) => Promise<ArkVal>,
  ) {
    super(params, returnType)
    this.body = (...args: ArkVal[]) => call(() => innerBody(...args))
  }
}

export class ArkObject extends ArkObjectBase {
  static properties: Map<string, ArkCallable> = new Map([...ArkObjectBase.methods])

  constructor(properties: Map<string, ArkVal>) {
    super()
    this.properties = properties
  }

  static subClass(properties: Map<string, ArkCallable> = new Map()): typeof ArkObject {
    return class extends ArkObject {
      static properties: Map<string, ArkCallable> = new Map([...ArkObject.properties])

      static {
        this.addMethods([...properties.entries()])
      }
    }
  }
}

export class NativeObject extends ArkAbstractObjectBase {
  constructor(public obj: object) {
    super()
  }

  getMethod(prop: string): ArkCallable {
    return fromJs((this.obj as {[key: string]: unknown})[prop], this.obj, true) as ArkCallable
  }

  get(prop: string): ArkVal {
    return fromJs((this.obj as {[key: string]: unknown})[prop], this.obj) ?? ArkUndefined
  }

  set(prop: string, val: ArkVal) {
    (this.obj as {[key: string]: unknown})[prop] = toJs(val)
    return val
  }
}

export class ArkList extends ArkObjectBase {
  static methods: Map<string, ArkCallable> = new Map([...ArkObjectBase.methods])

  static {
    ArkList.addMethods([
      ['len', new NativeFn(['len'], (thisVal) => ArkNumber((thisVal as ArkList).list.length))],
      ['get', new NativeFn(['index'], (thisVal, index) => (thisVal as ArkList).list[toJs(index) as number])],
      ['set', new NativeFn(
        ['index', 'val'],
        (thisVal, index, val) => {
          (thisVal as ArkList).list[toJs(index) as number] = val
          return thisVal
        },
      )],
      ['push', new NativeFn(['item'], (thisVal, item) => {
        (thisVal as ArkList).list.push(item)
        return thisVal
      })],
      ['pop', new NativeFn([], (thisVal) => {
        (thisVal as ArkList).list.pop()
        return thisVal
      })],
      ['slice', new NativeFn(['from', 'to'], (thisVal, from, to) => new ArkList(
        (thisVal as ArkList).list.slice(
          from instanceof ArkNumberVal ? from.val : 0,
          to instanceof ArkNumberVal ? to.val : undefined,
        ),
      ))],
      ['iter', new NativeFn([], (thisVal) => {
        const list = (thisVal as ArkList).list
        const generator = (function* listGenerator() {
          for (const elem of list) {
            yield elem
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
      ['sorted', new NativeFn([], (thisVal) => new ArkList((thisVal as ArkList).list.map(toJs).toSorted().map((v) => fromJs(v))))],
      ['join', new NativeFn(['sep'], (thisVal, sep) => ArkString((thisVal as ArkList).list.map(toJs).join((sep as ArkStringVal).val)))],
    ])
  }

  constructor(public list: ArkVal[]) {
    super()
  }
}

export class ArkMap extends ArkObjectBase {
  static methods: Map<string, ArkCallable> = new Map([...ArkObjectBase.methods])

  static {
    ArkMap.addMethods([
      ['get', new NativeFn(['index'], (thisVal, index) => (thisVal as ArkMap).map.get(index) ?? ArkNull())],
      ['set', new NativeFn(
        ['index', 'val'],
        (thisVal, index, val) => {
          (thisVal as ArkMap).map.set(index, val)
          return thisVal
        },
      )],
      ['delete', new NativeFn(['index'], (thisVal, index) => {
        (thisVal as ArkMap).map.delete(index)
        return thisVal
      })],
      ['has', new NativeFn(['index'], (thisVal, index) => ArkBoolean((thisVal as ArkMap).map.has(index)))],
      ['iter', new NativeFn([], (thisVal) => {
        const map = (thisVal as ArkMap).map
        const generator = (function* mapEntriesGenerator() {
          for (const [key, value] of map.entries()) {
            yield new ArkList([key, value])
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
      ['keys', new NativeFn([], (thisVal) => {
        const map = (thisVal as ArkMap).map
        const generator = (function* mapKeysGenerator() {
          for (const key of map.keys()) {
            yield key
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
      ['values', new NativeFn([], (thisVal) => {
        const map = (thisVal as ArkMap).map
        const generator = (function* mapValuesGenerator() {
          for (const value of map.values()) {
            yield value
          }
          return ArkNull()
        }())
        return new NativeFn([], () => generator.next().value)
      })],
    ])
  }

  constructor(public map: Map<ArkVal, ArkVal>) {
    super()
  }
}

export abstract class ArkRef {
  abstract get(): ArkVal

  abstract set(val: ArkVal): ArkVal
}

// ts-unused-exports:disable-next-line
export class ArkValRef extends ArkRef {
  constructor(public val: ArkVal = ArkNull()) {
    super()
  }

  get(): ArkVal {
    return this.val
  }

  set(val: ArkVal): ArkVal {
    this.val = val
    return val
  }
}

class ArkPropertyRefError extends Error {}

// ts-unused-exports:disable-next-line
export class ArkPropertyRef extends ArkRef {
  constructor(public obj: ArkAbstractObjectBase, public prop: string) {
    super()
    if (obj.get(prop) === ArkUndefined) {
      throw new ArkPropertyRefError('Invalid property')
    }
  }

  get() {
    const val = this.obj.get(this.prop)
    return val
  }

  set(val: ArkVal) {
    this.obj.set(this.prop, val)
    return val
  }
}

export const globals = new ArkObject(new Map<string, ArkVal>([
  // Placeholder (will be set at start-up).
  ['argv', new ArkList([])],

  // Ursa's prelude (see also prelude.ursa).
  ['version', ArkString(programVersion)],
  ['debug', new NativeFn(['obj'], (obj) => {
    debug(obj)
    return ArkNull()
  })],
  ['fs', new NativeFn(['path'], (path) => new NativeObject(new FsMap((path as ArkStringVal).val)))],
  ['sleep', new NativeOperation(['ms'], function* gen(ms) {
    yield* sleep((ms as ArkNumberVal).val)
    return ArkNull()
  })],
  ['action', new NativeFn(
    ['resolve', 'reject'],
    function* gen(fn) {
      const result = yield* action(
        toJs(fn) as (resolve: Resolve<unknown>, reject: Reject) => Operation<void>,
      )
      return fromJs(result)
    },
  )],

  // JavaScript bindings—globals (with "use").
  ['js', new ArkObject(new Map([[
    'use', new NativeFn([], (arg) => {
      const name = toJs(arg) as string
      // eslint-disable-next-line max-len
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      return fromJs((globalThis as any)[name])
    }),
  ]]))],

  // JavaScript bindings—imported libraries (with "use").
  ['jslib', new ArkObject(new Map([[
    'use', new NativeAsyncFn([], async (...args) => {
      const importPath = args.map(toJs).join('.')
      const module: unknown = await import(importPath)
      return fromJs(module)
    }),
  ]]))],
]))

// Clone interpreter globals
export const jsGlobals = new ArkObject(new Map())
for (const [k, v] of globals.properties.entries()) {
  jsGlobals.set(k, v)
}

export const globalTypes = new Map<string, ArkType>([
  ['Null', ArkNull().type],
  ['Boolean', ArkBoolean(true).type],
  ['Number', ArkNumber(0).type],
  ['String', ArkString('').type],

  ['Object', globals.type],
  ['List', new ArkList([]).type],
  ['Map', new ArkMap(new Map()).type],
])

// FFI
class ArkFromJsError extends Error {}

function fromJs(x: unknown, thisObj?: object, asMethod: boolean = false): ArkVal {
  if (x === null || x === undefined) {
    return ArkNull()
  }
  if (typeof x === 'boolean') {
    return ArkBoolean(x)
  }
  if (typeof x === 'number') {
    return ArkNumber(x)
  }
  if (typeof x === 'string') {
    return ArkString(x)
  }
  if (typeof x === 'function') {
    // eslint-disable-next-line max-len
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/ban-types
    const fn: Function = thisObj ? x.bind(thisObj) : x
    if (asMethod) {
      return new NativeAsyncFn(
        [],
        new ArkType([], new Map()), // FIXME: 'any'
        async (_this, ...args) => fromJs(await fn(...args.map(toJs))),
      )
    }
    return new NativeAsyncFn(
      [],
      new ArkType([], new Map()), // FIXME: 'any'
      async (...args: ArkVal[]) => fromJs(await fn(...args.map(toJs))),
    )
  }
  if (x instanceof Array) {
    return new ArkList(x.map((e) => fromJs(e)))
  }
  if (x instanceof Map) {
    const map = new Map<ArkVal, ArkVal>()
    for (const [k, v] of x) {
      map.set(fromJs(k), fromJs(v))
    }
    return new ArkMap(map)
  }
  if (typeof x === 'object') {
    return new NativeObject(x)
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  throw new ArkFromJsError(`Cannot convert JavaScript value ${x}`)
}

export function toJs(val: ArkVal): unknown {
  if (val instanceof ArkConcreteVal) {
    return val.val
  } else if (val instanceof ArkObject) {
    const obj: {[key: string]: unknown} = {}
    for (const [k, v] of (val.constructor as typeof ArkObjectBase).methods) {
      obj[k] = toJs(v)
    }
    for (const [k, v] of val.properties) {
      obj[k] = toJs(v)
    }
    return obj
  } else if (val instanceof ArkMap) {
    const jsMap = new Map<unknown, unknown>()
    for (const [k, v] of val.map) {
      jsMap.set(toJs(k), toJs(v))
    }
    return jsMap
  } else if (val instanceof ArkList) {
    return val.list.map(toJs)
  } else if (val instanceof ArkClosure) {
    return async (...args: unknown[]) => {
      const locals = args.map((arg) => new ArkValRef(fromJs(arg)))
      return val.call(locals)
    }
  } else if (val instanceof NativeFn || val instanceof NativeAsyncFn) {
    return async (...args: unknown[]) => toJs(
      await run(() => val.body(...args.map((arg) => fromJs(arg)))),
    )
  }
  return val
}
