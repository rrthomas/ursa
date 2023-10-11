import assert from 'assert'
import {
  CompiledArk, Environment, FreeVars, Namespace,
} from './compiler.js'

export class Stack<T> {
  public stack: T[][]

  constructor(outerStack: T[][] = [[]]) {
    assert(outerStack.length > 0)
    this.stack = outerStack
  }

  push(items: T[]) {
    return new (this.constructor as any)(
      [[...items, ...this.stack[0].slice()], ...this.stack.slice(1)],
    )
  }

  pushFrame(frame: T[]) {
    return new (this.constructor as any)([frame, ...this.stack.slice()])
  }
}

// FIXME: Make the stack of type [Val[], Ref[]][]: pairs of frame and upvars
export class RuntimeStack extends Stack<Val> {}

export class ArkState {
  stack = new RuntimeStack()

  captureFreeVars(cl: Fexpr): Val[] {
    const frame: Val[] = []
    for (const [loc] of cl.boundFreeVars) {
      const ref = new ValRef(this.stack.pushFrame([]).stack[loc.level][loc.index])
      frame.push(ref)
    }
    return frame
  }

  evaluateArgs(...args: Val[]) {
    const evaluatedArgs: Val[] = []
    for (const arg of args) {
      evaluatedArgs.push(arg.eval(this))
    }
    return evaluatedArgs
  }

  run(compiledVal: CompiledArk, env: Namespace = globals): Val {
    const val = link(compiledVal, env)
    this.stack = new RuntimeStack()
    return val.eval(this)
  }
}

// Base class for compiled code.
export class Val {
  // Uncomment the following for debug.
  // FIXME: make this a run-time (or build-time?) option.
  // static counter = 0

  // uid: number

  // constructor() {
  //   this.uid = Val.counter
  //   Val.counter += 1
  // }

  debug: Map<string, any> = new Map()

  eval(_ark: ArkState): Val {
    return this
  }
}

class ConcreteVal<T> extends Val {
  constructor(public val: T) {
    super()
  }
}

class ConcreteInterned {
  constructor() {
    throw new Error('use ConcreteInterned.create, not constructor')
  }

  private static intern: Map<any, ConcreteVal<any>> = new Map()

  static value<T>(rawVal: T): ConcreteVal<T> {
    let val = ConcreteInterned.intern.get(rawVal)
    if (val === undefined) {
      val = new ConcreteVal(rawVal)
      ConcreteInterned.intern.set(rawVal, val)
    }
    return val
  }
}

export const Null = () => ConcreteInterned.value(null)
export const Bool = (b: boolean) => ConcreteInterned.value(b)
export const Num = (n: number) => ConcreteInterned.value(n)
export const Str = (s: string) => ConcreteInterned.value(s)

export class NonLocalReturn extends Error {
  constructor(public readonly val: Val = Null()) {
    super()
  }
}

export class BreakException extends NonLocalReturn {}

export class ReturnException extends NonLocalReturn {}

export class ContinueException extends NonLocalReturn {}

export class PropertyException extends Error {}

export class AssException extends Error {}

export function bindArgsToParams(params: string[], args: Val[]): Ref[] {
  const frame: ValRef[] = params.map(
    (_key, index) => new ValRef(args[index] ?? Null()),
  )
  if (args.length > params.length) {
    // FIXME: Support '...' as an identifier
    frame.push(new ValRef(new List(args.slice(params.length))))
  }
  return frame
}

class FexprClosure extends Val {
  constructor(public params: string[], public freeVars: Val[], public body: Val) {
    super()
  }
}

class FnClosure extends FexprClosure {}

export class Fexpr extends Val {
  boundFreeVars: [StackRef, SymRef[]][] = []

  constructor(public params: string[], protected freeVars: FreeVars, public body: Val) {
    super()
    let numStackFreeVars = 0
    for (const [, symrefs] of this.freeVars) {
      let isStackFreeVar = false
      for (const symref of symrefs) {
        const loc = symref.ref
        assert(loc !== undefined)
        if (loc instanceof StackRef) {
          assert(!(loc instanceof StackRefRef))
          assert(loc.level > 0)
          if (!isStackFreeVar) {
            isStackFreeVar = true
            this.boundFreeVars.push([loc, symrefs])
            numStackFreeVars += 1
          }
          symref.ref = new StackRefRef(1, numStackFreeVars - 1)
        }
      }
    }
  }

  eval(ark: ArkState): Val {
    return new FexprClosure(this.params, ark.captureFreeVars(this), this.body)
  }
}

export class Fn extends Fexpr {
  eval(ark: ArkState): Val {
    return new FnClosure(this.params, ark.captureFreeVars(this), this.body)
  }
}

export class NativeFexpr extends Val {
  constructor(
    public name: string, // FIXME: remove name, use debug info.
    public body: (ark: ArkState, ...args: Val[]) => Val,
  ) {
    super()
  }
}

export class NativeFn extends NativeFexpr {}

export abstract class Ref extends Val {
  abstract get(stack: RuntimeStack): Val

  abstract set(stack: RuntimeStack, val: Val): Val
}

export class ValRef extends Ref {
  constructor(public val: Val = Null()) {
    super()
  }

  get(_stack: RuntimeStack): Val {
    return this.val
  }

  set(stack: RuntimeStack, val: Val): Val {
    this.val = val
    return val
  }
}

export class Get extends Val {
  constructor(public val: Val) {
    super()
  }

  eval(ark: ArkState): Val {
    return (this.val.eval(ark) as Ref).get(ark.stack)
  }
}

export class Ass extends Val {
  constructor(public ref: Val, public val: Val) {
    super()
  }

  eval(ark: ArkState): Val {
    const ref = this.ref.eval(ark)
    const res = this.val.eval(ark)
    if (!(ref instanceof Ref || ref instanceof SymRef)) {
      throw new AssException('assignment to non-Ref/SymRef')
    }
    ref.set(ark.stack, res)
    return res
  }
}

export class StackRef extends Ref {
  constructor(public level: number, public index: number) {
    super()
  }

  get(stack: RuntimeStack): Val {
    return stack.stack[this.level][this.index]
  }

  set(stack: RuntimeStack, val: Val) {
    stack.stack[this.level][this.index] = val
    return val
  }
}

export class StackRefRef extends StackRef {
  get(stack: RuntimeStack): Val {
    return (stack.stack[this.level][this.index] as Ref).get(stack)
  }

  set(stack: RuntimeStack, val: Val) {
    const ref = stack.stack[this.level][this.index] as Ref;
    ref.set(stack, val)
    return val
  }
}

export class RefRef {
  ref: Ref

  constructor(ref: Ref) {
    this.ref = ref
  }

  get(stack: RuntimeStack): Val {
    return this.ref.get(stack)
  }

  set(stack: RuntimeStack, val: Val) {
    this.ref.set(stack, val)
    return val
  }
}

export class SymRef extends Val {
  ref: Ref | undefined

  constructor(env: Environment, name: string) {
    super()
    this.ref = env.getIndex(name)
    this.debug.set('name', name)
    this.debug.set('env', JSON.stringify(env))
  }

  get(stack: RuntimeStack): Val {
    return this.ref!.get(stack)
  }

  set(stack: RuntimeStack, val: Val) {
    return this.ref!.set(stack, val)
  }

  eval(ark: ArkState): Val {
    return this.get(ark.stack)
  }
}

export const intrinsics: {[key: string]: Val} = {
  pos: new NativeFn('pos', (_ark: ArkState, val: Val) => Num(+toJs(val))),
  neg: new NativeFn('neg', (_ark: ArkState, val: Val) => Num(-toJs(val))),
  not: new NativeFn('not', (_ark: ArkState, val: Val) => Bool(!toJs(val))),
  seq: new NativeFexpr('seq', (ark: ArkState, ...args: Val[]) => {
    let res: Val = Null()
    for (const exp of args) {
      res = exp.eval(ark)
    }
    return res
  }),
  if: new NativeFexpr('if', (ark: ArkState, cond: Val, e_then: Val, e_else: Val) => {
    const condVal = cond.eval(ark)
    if (toJs(condVal)) {
      return e_then.eval(ark)
    }
    return e_else ? e_else.eval(ark) : Null()
  }),
  and: new NativeFexpr('and', (ark: ArkState, left: Val, right: Val) => {
    const leftVal = left.eval(ark)
    if (toJs(leftVal)) {
      return right.eval(ark)
    }
    return leftVal
  }),
  or: new NativeFexpr('or', (ark: ArkState, left: Val, right: Val) => {
    const leftVal = left.eval(ark)
    if (toJs(leftVal)) {
      return leftVal
    }
    return right.eval(ark)
  }),
  loop: new NativeFexpr('loop', (ark: ArkState, body: Val) => {
    for (; ;) {
      try {
        body.eval(ark)
      } catch (e) {
        if (e instanceof BreakException) {
          return e.val
        }
        if (!(e instanceof ContinueException)) {
          throw e
        }
      }
    }
  }),
  break: new NativeFn('break', (_ark: ArkState, val: Val) => {
    throw new BreakException(val)
  }),
  continue: new NativeFn('continue', () => {
    throw new ContinueException()
  }),
  return: new NativeFn('return', (_ark: ArkState, val: Val) => {
    throw new ReturnException(val)
  }),
  '=': new NativeFn('=', (_ark: ArkState, left: Val, right: Val) => Bool(toJs(left) === toJs(right))),
  '!=': new NativeFn('!=', (_ark: ArkState, left: Val, right: Val) => Bool(toJs(left) !== toJs(right))),
  '<': new NativeFn('<', (_ark: ArkState, left: Val, right: Val) => Bool(toJs(left) < toJs(right))),
  '<=': new NativeFn('<=', (_ark: ArkState, left: Val, right: Val) => Bool(toJs(left) <= toJs(right))),
  '>': new NativeFn('>', (_ark: ArkState, left: Val, right: Val) => Bool(toJs(left) > toJs(right))),
  '>=': new NativeFn('>=', (_ark: ArkState, left: Val, right: Val) => Bool(toJs(left) >= toJs(right))),
  '+': new NativeFn('+', (_ark: ArkState, left: Val, right: Val) => Num(toJs(left) + toJs(right))),
  '-': new NativeFn('-', (_ark: ArkState, left: Val, right: Val) => Num(toJs(left) - toJs(right))),
  '*': new NativeFn('*', (_ark: ArkState, left: Val, right: Val) => Num(toJs(left) * toJs(right))),
  '/': new NativeFn('/', (_ark: ArkState, left: Val, right: Val) => Num(toJs(left) / toJs(right))),
  '%': new NativeFn('%', (_ark: ArkState, left: Val, right: Val) => Num(toJs(left) % toJs(right))),
  '**': new NativeFn('**', (_ark: ArkState, left: Val, right: Val) => Num(toJs(left) ** toJs(right))),
}
export class Class extends Val {
  public val: Map<string, Val>

  constructor(obj: Map<string, Val>) {
    super()
    this.val = obj
  }
}

// FIXME: non-Literal classes should use default "eval" method
export class Obj extends Class {}

export class ObjLiteral extends Obj {
  eval(ark: ArkState): Val {
    const inits = new Map<string, Val>()
    for (const [k, v] of this.val) {
      inits.set(k, v.eval(ark))
    }
    return new Obj(inits)
  }
}

export class PropRef extends Ref {
  constructor(public obj: Obj, public prop: string) {
    super()
  }

  get(_stack: RuntimeStack) {
    return this.obj.val.get(this.prop) ?? Null()
  }

  set(_stack: RuntimeStack, val: Val) {
    this.obj.val.set(this.prop, val)
    return val
  }
}

export class DictLiteral extends Class {
  constructor(public map: Map<Val, Val>) {
    super(new Map<string, Val>([
      ['set', new NativeFn(
        'Dict.set',
        (_ark: ArkState, index: Val, val: Val) => {
          this.map.set(index, val)
          return val
        },
      )],
      ['get', new NativeFn(
        'Dict.get',
        (_ark: ArkState, index: Val) => this.map.get(index) ?? Null(),
      )],
    ]))
  }

  eval(ark: ArkState): Val {
    const evaluatedMap = new Map<any, Val>()
    for (const [k, v] of this.map) {
      evaluatedMap.set(k.eval(ark), v.eval(ark))
    }
    return new Dict(evaluatedMap)
  }
}

export class Dict extends DictLiteral {}

export class ListLiteral extends Class {
  constructor(public list: Val[]) {
    super(new Map<string, Val>([
      ['get', new NativeFn(
        'List.get',
        (_ark: ArkState, index: Val) => this.list[toJs(index)],
      )],
      ['set', new NativeFn(
        'List.set',
        (_ark: ArkState, index: Val, val: Val) => {
          this.list[toJs(index)] = val
          return val
        },
      )],
    ]))
    this.val.set('length', Num(this.list.length))
  }

  eval(ark: ArkState): Val {
    return new List(this.list.map((e) => e.eval(ark)))
  }
}

export class List extends ListLiteral {}

export class Let extends Val {
  constructor(public boundVars: string[], public body: Val) {
    super()
  }

  eval(ark: ArkState): Val {
    const frame = bindArgsToParams(this.boundVars, [])
    const oldStack = ark.stack
    ark.stack = ark.stack.push(frame)
    const res = this.body.eval(ark)
    ark.stack = oldStack
    return res
  }
}

export class Call extends Val {
  constructor(public fn: Val, public args: Val[]) {
    super()
  }

  eval(ark: ArkState): Val {
    const fn = this.fn.eval(ark)
    let args = this.args
    if (fn instanceof FnClosure) {
      args = ark.evaluateArgs(...this.args)
    }
    if (fn instanceof FexprClosure) {
      let res: Val = Null()
      try {
        const frame = bindArgsToParams(fn.params, args)
        const oldStack = ark.stack
        ark.stack = ark.stack.pushFrame(fn.freeVars).pushFrame(frame)
        res = fn.body.eval(ark)
        ark.stack = oldStack
      } catch (e) {
        if (!(e instanceof ReturnException)) {
          throw e
        }
        res = e.val
      }
      return res
    } else if (fn instanceof NativeFn) {
      return fn.body(ark, ...ark.evaluateArgs(...args))
    } else if (fn instanceof NativeFexpr) {
      return fn.body(ark, ...args)
    }
    throw new Error('invalid Call')
  }
}

export class Prop extends Val {
  // ref must compute a Ref
  constructor(public prop: string, public ref: Val) {
    super()
  }

  eval(ark: ArkState): Val {
    const obj = this.ref.eval(ark)
    return new PropRef(obj as Obj, this.prop)
  }
}

function jsToVal(x: any): Val {
  if (x === null || x === undefined) {
    return Null()
  }
  if (typeof x === 'boolean') {
    return Bool(x)
  }
  if (typeof x === 'number') {
    return Num(x)
  }
  if (typeof x === 'string') {
    return Str(x)
  }
  if (typeof x === 'function') {
    return new NativeFn(x.name, (_ark: ArkState, ...args: Val[]) => jsToVal(x(...args.map(toJs))))
  }
  if (typeof x === 'object') {
    return new ObjLiteral(x)
  }
  if (x instanceof Array) {
    return new ListLiteral(x)
  }
  if (x instanceof Map) {
    return new DictLiteral(x)
  }
  throw new Error(`cannot convert JavaScript value ${x}`)
}

export const globals = new Map([
  ['pi', new ValRef(Num(Math.PI))],
  ['e', new ValRef(Num(Math.E))],
  ['print', new ValRef(new NativeFn('print', (_ark: ArkState, obj: Val) => {
    console.log(toJs(obj))
    return Null()
  }))],
  ['debug', new ValRef(new NativeFn('debug', (_ark: ArkState, obj: Val) => {
    debug(obj)
    return Null()
  }))],
  // FIXME: make this work again!
  // ['js', new Ref(new Obj({
  //   use: new NativeFn('js', (...args: Val[]) => {
  //     const requirePath = (args.map(toJs).join('.'))
  //     // eslint-disable-next-line import/no-dynamic-require, global-require
  //     const module = require(requirePath)
  //     const wrappedModule = new Map()
  //     // eslint-disable-next-line guard-for-in
  //     for (const key in module) {
  //       wrappedModule.set(key, jsToVal(module[key]))
  //     }
  //     return new Obj(wrappedModule)
  //   }),
  // }))],
  ['JSON', new ValRef(new Obj(new Map([
    ['parse', new NativeFn('JSON.parse', (_ark: ArkState, str: Val) => jsToVal(JSON.parse(toJs(str))))],
    ['stringify', new NativeFn('JSON.stringify', (_ark: ArkState, val: Val) => Str(JSON.stringify(toJs(val))))],
  ])))],
])

// FIXME: support partial linking.
export function link(compiledVal: CompiledArk, env: Namespace): Val {
  const [val, freeVars] = compiledVal
  for (const [name, symrefs] of freeVars) {
    if (!env.has(name)) {
      throw new Error(`undefined symbol ${name}`)
    }
    for (const symref of symrefs) {
      symref.ref = new ValRef(env.get(name)!)
    }
  }
  return val
}

export function toJs(val: Val): any {
  if (val instanceof ConcreteVal) {
    return val.val
  } else if (val instanceof Obj) {
    const obj = {}
    for (const [k, v] of val.val) {
      (obj as any)[k] = toJs(v)
    }
    return obj
  } else if (val instanceof DictLiteral) {
    const jsMap = new Map<any, Val>()
    for (const [k, v] of val.map) {
      jsMap.set(toJs(k), toJs(v))
    }
    return jsMap
  } else if (val instanceof ListLiteral) {
    return val.list.map(toJs)
  }
  return val
}

export function serialize(val: Val) {
  function doSerialize(val: Val): any {
    if (val instanceof SymRef) {
      return val.debug.get('name')
    } else if (val instanceof NativeFexpr) {
      return val.name
    } else if (val instanceof ConcreteVal) {
      const rawVal = val.val
      if (typeof rawVal === 'string') {
        return ['str', val.val]
      }
      return val.val
    } else if (val instanceof PropRef) {
      return ['ref', ['prop', doSerialize(val.obj), val.prop]]
    } else if (val instanceof ValRef) {
      return ['ref', doSerialize(val.val)]
    } else if (val instanceof Get) {
      return ['get', doSerialize(val.val)]
    } else if (val instanceof Fn) {
      return ['fn', ['params', ...val.params], doSerialize(val.body)]
    } else if (val instanceof Fexpr) {
      return ['fexpr', ['params', ...val.params], doSerialize(val.body)]
    } else if (val instanceof Obj) {
      const obj = {}
      for (const [k, v] of val.val) {
        (obj as any)[k] = doSerialize(v)
      }
      return obj
    } else if (val instanceof DictLiteral) {
      const obj: any[] = ['map']
      for (const [k, v] of val.map) {
        obj.push([doSerialize(k), doSerialize(v)])
      }
      return obj
    } else if (val instanceof ListLiteral) {
      return ['list', ...val.list.map(doSerialize)]
    } else if (val instanceof Let) {
      return ['let', ['params', ...val.boundVars], doSerialize(val.body)]
    } else if (val instanceof Call) {
      return [doSerialize(val.fn), ...val.args.map(doSerialize)]
    } else if (val instanceof Ass) {
      return ['set', doSerialize(val.ref), doSerialize(val.val)]
    } else if (val instanceof Prop) {
      return ['prop', val.prop, doSerialize(val.ref)]
    } else if (val === undefined || val === null) {
      return Null()
    }
    return val.toString()
  }
  return JSON.stringify(doSerialize(val))
}

export function debug(x: any, depth: number | null = 1) {
  console.dir(x, {depth, colors: true})
}
