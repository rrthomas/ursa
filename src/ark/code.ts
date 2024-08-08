// Compiled Ark code.
// © Reuben Thomas 2023-2024
// Released under the MIT license.

import {Interval} from 'ohm-js'

import {
  ArkBoolean, ArkCallable, ArkList, ArkMap, ArkNull, ArkObject, ArkVal,
} from './data.js'
import {type ArkState} from './interpreter.js'
import {ArkFnType, ArkType, ArkTypedId} from './type.js'

export class ArkDebugInfo {
  uid: number | undefined

  name: string | undefined

  env: string | undefined
}

export abstract class ArkExp {
  static nextId = 0

  static debugEnumerable = process.env.DEBUG_ARK !== undefined

  constructor(public type: ArkType) {
    Object.defineProperty(this, 'debug', {enumerable: ArkExp.debugEnumerable})
    Object.defineProperty(this, 'sourceLoc', {enumerable: ArkExp.debugEnumerable})
    this.debug.uid = ArkExp.nextId
    ArkExp.nextId += 1
  }

  debug = new ArkDebugInfo()

  sourceLoc?: Interval
}

export class ArkLiteral extends ArkExp {
  constructor(public val: ArkVal = ArkNull()) {
    super(val.type)
  }
}

export class ArkLaunch extends ArkExp {
  constructor(public exp: ArkExp) {
    super(exp.type)
  }
}

export class ArkAwait extends ArkExp {
  constructor(public exp: ArkExp) {
    super(exp.type)
  }
}

export class ArkBreak extends ArkExp {
  constructor(public exp: ArkExp = new ArkLiteral(ArkNull())) {
    super(exp.type)
  }
}

export class ArkContinue extends ArkExp {
  constructor() {
    super(ArkNull().type)
  }
}

export class ArkReturn extends ArkExp {
  constructor(public exp: ArkExp = new ArkLiteral(ArkNull())) {
    super(exp.type)
  }
}

export class ArkYield extends ArkReturn {}

export class ArkContinuation extends ArkCallable {
  public done = false

  constructor(public state: ArkState, public returnType: ArkType) {
    super([new ArkTypedId('x', new ArkType([], new Map()))], returnType) // FIXME type
  }
}

export class ArkFn extends ArkExp {
  constructor(public params: ArkTypedId[], public capturedVars: ArkCapture[], public body: ArkExp) {
    // FIXME: memoize type constructors (like ConcreteVal)
    super(new ArkFnType(false, params, body.type))
  }
}
export class ArkGenerator extends ArkFn {}

export class ArkCall extends ArkExp {
  constructor(public fn: ArkExp, public args: ArkExp[]) {
    const fnType = fn.type as ArkFnType
    super(fnType.returnType)
  }
}

export class ArkInvoke extends ArkExp {
  constructor(public obj: ArkExp, public prop: string, public args: ArkExp[]) {
    super()
  }
}

export abstract class ArkLvalue extends ArkExp {}

export abstract class ArkNamedLoc extends ArkLvalue {
  constructor(public index: number, public name: string, type: ArkType, public isVar: boolean) {
    super(type)
  }
}
export class ArkLocal extends ArkNamedLoc {}
export class ArkCapture extends ArkNamedLoc {}

export class ArkSet extends ArkExp {
  constructor(public lexp: ArkLvalue, public exp: ArkExp) {
    super(exp.type)
  }
}

export class ArkObjectLiteral extends ArkExp {
  constructor(public properties: Map<string, ArkExp>) {
    super(new ArkObject().type)
  }
}

export class ArkProperty extends ArkLvalue {
  constructor(public obj: ArkExp, public prop: string) {
    const propType = obj.type.propertyTypes.get(prop)
    if (propType === undefined) {
      throw new Error(`Invalid property ${prop}`)
    }
    super(propType.type)
  }
}

export class ArkListLiteral extends ArkExp {
  constructor(public list: ArkExp[]) {
    super(new ArkList([]).type)
  }
}

export class ArkMapLiteral extends ArkExp {
  constructor(public map: Map<ArkExp, ArkExp>) {
    super(new ArkMap(new Map()).type)
  }
}

export class ArkBoundVar {
  constructor(
    public name: string,
    public type: ArkType,
    public isVar: boolean,
    public index: number,
    public init: ArkExp,
  ) {}
}

export class ArkLet extends ArkExp {
  constructor(public boundVars: ArkBoundVar[], public body: ArkExp) {
    super(body.type)
  }
}

export class ArkSequence extends ArkExp {
  constructor(public exps: ArkExp[]) {
    super(exps[exps.length - 1].type)
  }
}

export class ArkIf extends ArkExp {
  constructor(public cond: ArkExp, public thenExp: ArkExp, public elseExp?: ArkExp) {
    if (cond.type !== ArkBoolean(true).type) {
      throw new Error("Condition of 'if' must be boolean")
    }
    if (elseExp !== undefined && thenExp.type !== elseExp.type) {
      throw new Error("Type of 'if' result does not match type of 'else'")
    }
    super(thenExp.type)
  }
}

export class ArkAnd extends ArkExp {
  constructor(public left: ArkExp, public right: ArkExp) {
    if (left.type !== ArkBoolean(true).type || right.type !== ArkBoolean(true).type) {
      throw new Error("Arguments of 'and' must be boolean")
    }
    super(ArkBoolean(true).type)
  }
}

export class ArkOr extends ArkExp {
  constructor(public left: ArkExp, public right: ArkExp) {
    if (left.type !== ArkBoolean(true).type || right.type !== ArkBoolean(true).type) {
      throw new Error("Arguments of 'or' must be boolean")
    }
    super(ArkBoolean(true).type)
  }
}

export class ArkLoop extends ArkExp {
  constructor(public body: ArkExp, public localsDepth: number) {
    super(body.type)
  }
}
