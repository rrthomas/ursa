// Ursa test utilities.
// © Reuben Thomas 2023
// Released under the MIT license.

import fs from 'fs'
import test, {ExecutionContext, Macro} from 'ava'
import tmp from 'tmp'
import util from 'util'
import {ExecaReturnValue, execa} from 'execa'
import {compareSync, Difference} from 'dir-compare'

import {ArkState, debug} from './ark/interpreter.js'
import {compile as arkCompile, CompiledArk} from './ark/compiler.js'
import {toJs} from './ark/ffi.js'
import {valToJs} from './ark/serialize.js'
import {compile as ursaCompile} from './ursa/compiler.js'

const command = process.env.NODE_ENV === 'coverage' ? './bin/test-run.sh' : './bin/run.js'

async function run(args: string[]) {
  return execa(command, args)
}

function doTestGroup(
  title: string,
  compile: (expr: string) => CompiledArk,
  tests: [string, unknown][],
) {
  test(title, async (t) => {
    for (const [source, expected] of tests) {
      const compiled = compile(source)
      if (process.env.DEBUG) {
        debug(compiled, null)
      }
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(toJs(await new ArkState().run(compiled)), expected)
    }
  })
}

export function testArkGroup(title: string, tests: [string, unknown][]) {
  return doTestGroup(title, arkCompile, tests)
}

export function testUrsaGroup(title: string, tests: [string, unknown][]) {
  return doTestGroup(title, ursaCompile, tests)
}

async function doCliTest(
  t: ExecutionContext,
  syntax: string,
  file: string,
  args?: string[],
  expectedStdout?: string,
  expectedStderr?: string,
) {
  const tempFile = tmp.tmpNameSync()
  try {
    const {stdout} = await run([`--syntax=${syntax}`, `--output=${tempFile}`, `${file}.${syntax}`, ...args ?? []])
    const result: unknown = JSON.parse(fs.readFileSync(tempFile, {encoding: 'utf-8'}))
    const expected: unknown = JSON.parse(fs.readFileSync(`${file}.result.json`, {encoding: 'utf-8'}))
    t.deepEqual(result, expected)
    if (syntax === 'json') {
      const source = fs.readFileSync(`${file}.json`, {encoding: 'utf-8'})
      const compiled = arkCompile(source)
      t.deepEqual(valToJs(compiled.value), JSON.parse(source))
    }
    if (expectedStdout !== undefined) {
      t.is(stdout, expectedStdout)
    }
  } catch (error) {
    if (expectedStderr !== undefined) {
      t.is((error as ExecaReturnValue).stderr.slice('run.js: '.length), expectedStderr)
      if (expectedStdout !== undefined) {
        t.is((error as ExecaReturnValue).stdout, expectedStdout)
      }
    } else {
      throw error
    }
  }
}

function cliTest(syntax: string) {
  return test.macro(
    async (
      t: ExecutionContext,
      file: string,
      args?: string[],
      expectedStdout?: string,
      expectedStderr?: string,
    ) => {
      await doCliTest(t, syntax, file, args, expectedStdout, expectedStderr)
    },
  )
}

function diffsetDiffsOnly(diffSet: Difference[]): Difference[] {
  return diffSet.filter((diff) => diff.state !== 'equal')
}

async function doDirTest(
  t: ExecutionContext,
  dir: string,
  callback: (t: ExecutionContext, tmpDirPath: string) => void | Promise<void>,
) {
  const tmpDir = tmp.dirSync({unsafeCleanup: true})
  t.teardown(() => {
    // AVA seems to prevent automatic cleanup.
    tmpDir.removeCallback()
  })
  await callback(t, tmpDir.name)
  const compareResult = compareSync(tmpDir.name, dir, {
    compareContent: true,
    excludeFilter: '.gitkeep',
  })
  t.assert(
    compareResult.same,
    util.inspect(diffsetDiffsOnly(compareResult.diffSet as Difference[])),
  )
}

export const dirTest = test.macro(async (
  t: ExecutionContext,
  dir: string,
  callback: (t: ExecutionContext, tmpDirPath: string) => void | Promise<void>,
) => {
  await doDirTest(t, dir, callback)
})

const ursaCliDirTest = test.macro(async (
  t: ExecutionContext,
  file: string,
  expectedDirPath: string,
  args?: string[],
  expectedStdout?: string,
  expectedStderr?: string,
) => {
  await doDirTest(
    t,
    expectedDirPath,
    async (t, tmpDirPath) => (
      doCliTest(t, 'ursa', file, [tmpDirPath, ...args ?? []], expectedStdout, expectedStderr)
    ),
  )
})

function mkTester<Args extends unknown[]>(macro: Macro<Args, unknown>) {
  return (title: string, ...args: Args) => {
    test(title, macro, ...args)
  }
}

export const arkTest = mkTester(cliTest('json'))
export const ursaTest = mkTester(cliTest('ursa'))
export const ursaDirTest = mkTester(ursaCliDirTest)
