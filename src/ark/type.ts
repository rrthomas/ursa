// Ark types.
// © Reuben Thomas 2023-2024
// Released under the MIT license.

import keyalesce from 'keyalesce'
import {ArkCallable, ArkVal} from './data.js'

export class ArkType {
  constructor(
    public supertypes: ArkType[],
    public propertyTypes: Map<string, ArkPropertyType>,
  ) {}
}

export const ArkUndefinedType = new ArkType([], new Map())

export class ArkTypedId {
  constructor(public name: string, public type: ArkType) {}
}

export class ArkPropertyType {
  constructor(public isVar: boolean, public type: ArkType | ArkGenericType) {}
}

export class ArkGenericType extends ArkType {
  private constructor(public params: ArkType[]) {
    super([], new Map()) // FIXME
  }

  private static registry = new Map<unknown, ArkGenericType>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static of(cls: {new(...args: any[]): ArkVal}, params: ArkType[]): ArkGenericType {
    const key = keyalesce([cls, ...params])
    let type = ArkGenericType.registry.get(key)
    if (type === undefined) {
      type = new ArkGenericType(params)
      ArkGenericType.registry.set(key, type)
    }
    return type
  }
}

export class ArkFnType extends ArkType {
  constructor(
    public isGenerator: boolean,
    public params: ArkTypedId[],
    public returnType: ArkType,
  ) {
    super([], new Map([[
      'call',
      new ArkPropertyType(
        false,
        ArkGenericType.of(ArkCallable, [...params.map((p) => p.type), returnType]),
      ),
    ]]))
  }
}
