// Ursa command-line front-end and REPL.
// © Reuben Thomas 2023-2024
// Released under the GPL version 3, or (at your option) any later version.

import assert from 'assert'
import path from 'path'
import * as readline from 'readline'
import {fileURLToPath} from 'url'

import {ArgumentParser, RawDescriptionHelpFormatter} from 'argparse'
import envPaths from 'env-paths'
import fs, {PathOrFileDescriptor} from 'fs-extra'
import tildify from 'tildify'
import {rollup} from 'rollup'
import {nodeResolve} from '@rollup/plugin-node-resolve'
import tmp from 'tmp'

import programVersion from '../version.js'
import {debug} from '../ark/util.js'
import {
  globals, jsGlobals, toJs, ArkNull, ArkList, ArkVal, ArkString, ArkObject, ArkValRef,
} from '../ark/data.js'
import {
  ArkExp, ArkLet, ArkListLiteral, ArkObjectLiteral, ArkSequence,
} from '../ark/code.js'
import {Environment, TypedLocation} from '../ark/compiler-utils.js'
import {ArkState} from '../ark/interpreter.js'
import {compile as arkCompile} from '../ark/reader.js'
import {serializeVal} from '../ark/serialize.js'
import {runWithTraceback, compile as ursaCompile} from './compiler.js'
import {format} from './fmt.js'
import {
  arkToJs, evalArkJs, preludeJs, runtimeContext,
} from '../ark/compiler/index.js'
import {expToInst} from '../ark/flatten.js'
import {ArkType} from '../ark/type.js'

// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = fileURLToPath(new URL('.', import.meta.url))

if (process.env.DEBUG) {
  Error.stackTraceLimit = Infinity
}

const historyFile = process.env.URSA_HISTORY
  ?? path.join(envPaths('ursa', {suffix: ''}).config, 'history')

// Read and process arguments
const parser = new ArgumentParser({
  description: 'The Ursa language.',
  formatter_class: RawDescriptionHelpFormatter,
  epilog: `\`-' given as a file name means standard input or output.

If just one non-option argument is given, Ursa treats it as a FILE to be \`run'.

Command line history is saved to the file given by the environment variable
URSA_HISTORY (default: ${tildify(historyFile)})`,
})
parser.add_argument('--version', {
  action: 'version',
  version: `%(prog)s ${programVersion}
© 2023-2025 Reuben Thomas <rrt@sc3d.org>
https://github.com/ursalang/ursa
Distributed under the GNU General Public License version 3, or (at
your option) any later version. There is no warranty.`,
})
parser.add_argument('--syntax', {
  default: 'ursa', choices: ['ursa', 'json'], help: 'syntax to use [default: ursa]',
})
parser.add_argument('--target', {
  default: 'ark', choices: ['ark', 'js'], help: 'compile target to use [default: ark]',
})

const subparsers = parser.add_subparsers({description: 'action to take'})

function addExecArgs(parser: ArgumentParser) {
  parser.add_argument('argument', {metavar: 'ARGUMENT', help: 'arguments to the Ursa program', nargs: '*'})
  parser.add_argument('--output', '-o', {metavar: 'FILE', help: 'JSON output file [default: standard output]'})
  parser.add_argument('--interactive', '-i', {action: 'store_true', help: 'enter interactive mode after running given code'})
}

const runParser = subparsers.add_parser('run', {aliases: ['r'], description: 'Run Ursa program'})
runParser.set_defaults({func: runCommand})
runParser.add_argument('source', {metavar: 'FILE', help: 'Ursa program to run'})
addExecArgs(runParser)

const evalParser = subparsers.add_parser('eval', {aliases: ['e'], description: 'Evaluate Ursa expression'})
evalParser.set_defaults({func: evalCommand})
evalParser.add_argument('source', {metavar: 'CODE', help: 'Ursa code to evaluate'})
addExecArgs(evalParser)

const interactParser = subparsers.add_parser('interact', {aliases: ['i', 'repl', 'interactive'], description: 'Run in interactive mode'})
interactParser.set_defaults({func: interactCommand})

const compileParser = subparsers.add_parser('compile', {aliases: ['c'], description: 'Compile source code to JSON'})
compileParser.set_defaults({func: compileCommand})
compileParser.add_argument('source', {metavar: 'FILE', help: 'Ursa program to compile'})
compileParser.add_argument('--output', '-o', {metavar: 'FILE', help: 'JSON output file [default: standard output]'})
compileParser.add_argument('--executable', '-x', {action: 'store_true', help: 'Output a complete executable'})

const fmtParser = subparsers.add_parser('fmt', {aliases: ['f', 'format'], description: 'Format source code'})
fmtParser.set_defaults({func: fmtCommand})
fmtParser.add_argument('source', {metavar: 'FILE', help: 'source code to format'})
fmtParser.add_argument('--output', '-o', {metavar: 'FILE', help: 'output file [default: standard output]'})
fmtParser.add_argument('--indent', {metavar: 'STRING', help: 'indent string'})

interface Args {
  // Global arguments
  syntax: string
  func: (args: Args) => Promise<void>

  // Run/compile/eval arguments
  source: string
  argument: string[]
  output: string | undefined
  interactive: boolean
  target: string
  executable: boolean

  // Format arguments
  width: number
  indent: string
  onelineFactor: number
}

// Utility routines.

// Get output filename, if any
type OutputFileResult<T extends boolean> =
  T extends true ? PathOrFileDescriptor : (PathOrFileDescriptor | undefined)
function getOutputFile<T extends boolean>(args: Args, useStdoutIfUndefined: T): OutputFileResult<T>
function getOutputFile(
  args: Args,
  useStdoutIfUndefined: boolean,
): OutputFileResult<typeof useStdoutIfUndefined> {
  let outputFile: PathOrFileDescriptor | undefined = args.output
  if (outputFile === '-' || (useStdoutIfUndefined && outputFile === undefined)) {
    outputFile = process.stdout.fd
  }
  return outputFile
}

// Program name for argv[0]
let prog: string

// Use standard input if requested
function getInputFile(args: Args): PathOrFileDescriptor {
  let inputFile: PathOrFileDescriptor = args.source
  if (args.source !== '-') {
    prog = inputFile
  } else {
    inputFile = process.stdin.fd
    prog = '(stdin)'
  }
  return inputFile
}

function readSourceFile(inputFile: PathOrFileDescriptor) {
  const source = fs.readFileSync(inputFile, {encoding: 'utf-8'})
  if (source.startsWith('#!')) {
    return source.substring(source.indexOf('\n'))
  }
  return source
}

function compile(
  args: Args,
  exp: string,
  env: Environment = new Environment(),
  startRule?: string,
): ArkExp {
  let compiled: ArkExp
  if (args.syntax === 'json') {
    compiled = arkCompile(JSON.parse(exp), env)
  } else {
    compiled = ursaCompile(exp, env, startRule)
  }
  if (process.env.DEBUG) {
    console.log('Compiled Ark')
    debug(compiled, null)
  }
  return compiled
}

function addReturnValues(exp: ArkExp, topLevelVars: Map<string, ArkExp> = new Map()) {
  if (exp instanceof ArkLet) {
    // FIXME: respect var-ness
    exp.boundVars.forEach((bv) => topLevelVars.set(bv.name, bv.init))
    exp.body = addReturnValues(exp.body, topLevelVars)
    return exp
  } else if (exp instanceof ArkSequence) {
    exp.exps[exp.exps.length - 1] = addReturnValues(exp.exps[exp.exps.length - 1], topLevelVars)
    return exp
  } else {
    return new ArkListLiteral([exp, new ArkObjectLiteral(topLevelVars)])
  }
}

function extractReturnValues(ark: ArkState, env: Environment, result: ArkVal | undefined) {
  assert(result instanceof ArkList)
  assert(result.list.length === 2)
  const newVars = result.list[1] as ArkObject
  assert(newVars instanceof ArkObject)
  for (const [k, v] of newVars.properties.entries()) {
    env = env.push([new TypedLocation(k, new ArkType([], new Map()), false)])
    ark.push([new ArkValRef(v)])
  }
  result = result.list[0]
  return {result, env}
}

async function repl(args: Args, ark = new ArkState(), env = new Environment()): Promise<ArkVal> {
  console.log(`Welcome to Ursa ${programVersion}.`)
  let history: string[] = []
  if (fs.existsSync(historyFile)) {
    history = fs.readFileSync(historyFile, {encoding: 'utf-8'}).split('\n').reverse()
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
    history,
    historySize: Infinity,
    removeHistoryDuplicates: true,
  })
  rl.on('history', (history: string[]) => {
    const reversedHistory: string[] = history.toReversed()
    fs.ensureDirSync(path.dirname(historyFile))
    fs.writeFileSync(historyFile, `${reversedHistory.join('\n')}\n`)
  })
  rl.on('SIGCONT', () => rl.resume())
  rl.prompt()
  let result: ArkVal = ArkNull()
  const rlSigintHandler = () => {
    process.removeAllListeners('SIGINT')
    process.kill(process.pid, 'SIGINT')
  }
  const interpSigintHandler = () => {
    process.removeListener('SIGINT', interpSigintHandler)
    ark.stop = true
  }
  rl.on('SIGINT', rlSigintHandler)
  for await (const line of rl) {
    try {
      const exp = addReturnValues(compile(args, line, env))
      ark.inst = expToInst(exp)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      process.addListener('SIGINT', interpSigintHandler)
      result = await runWithTraceback(ark)
      process.removeListener('SIGINT', interpSigintHandler)
      if (ark.stop) {
        console.log('interrupted!')
      }
      ({result, env} = extractReturnValues(ark, env, result))
      debug(toJs(result))
    } catch (error) {
      if (process.env.DEBUG) {
        throw error
      }
      if (error instanceof Error) {
        console.error(error.message)
      } else {
        console.error(error)
      }
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    rl.prompt()
  }
  return result
}

// Sub-command action routines.

async function runCode(source: string, args: Args) {
  const outputFile = getOutputFile(args, false)
  // Any otherwise uncaught exception is reported as an error.
  const ark = new ArkState()
  // Add command-line arguments.
  const ursaArgv = new ArkList(
    [ArkString(prog ?? process.argv[1]), ...args.argument.map((s) => ArkString(s))],
  )
  globals.set('argv', ursaArgv)
  jsGlobals.set('argv', ursaArgv)
  // Run the program
  let result: ArkVal | undefined
  let env = new Environment()
  if (source !== undefined) {
    let exp = compile(args, source)
    if (args.interactive) {
      exp = addReturnValues(exp)
    }
    if (args.target === 'ark') {
      const flat = expToInst(exp)
      ark.inst = flat
      result = await runWithTraceback(ark)
    } else {
      result = await evalArkJs(arkToJs(exp, prog), prog)
    }
    if (args.interactive) {
      ({result, env} = extractReturnValues(ark, env, result))
    }
  }
  if (source === undefined || args.interactive) {
    result = await repl(args, ark, env)
  }
  if (outputFile !== undefined) {
    const output = serializeVal(result ?? ArkNull()) ?? 'null'
    fs.writeFileSync(outputFile, output)
  }
}

async function evalCommand(args: Args) {
  prog = '(eval)'
  await runCode(args.source, args)
}

async function runCommand(args: Args) {
  const inputFile = getInputFile(args)
  await runCode(readSourceFile(inputFile), args)
}

async function interactCommand(args: Args) {
  await repl(args)
}

async function buildRuntime(inputFile: string) {
  const bundle = await rollup({
    input: inputFile,
    onwarn: () => {}, // Discard warnings from rollup
    plugins: [nodeResolve()],
  })
  const result = await bundle.generate({})
  await bundle.close()
  return result.output[0].code
}

function recordKeys<K extends PropertyKey, T>(object: Record<K, T>) {
  return Object.keys(object) as (K)[]
}

async function compileCommand(args: Args) {
  const outputFile = getOutputFile(args, true)
  // Any otherwise uncaught exception is reported as an error.
  // Read input
  const inputFile = getInputFile(args)
  const source = readSourceFile(inputFile)
  const exp = compile(args, source)
  let output = ''
  if (args.target === 'ark') {
    if (args.executable) {
      if (path.basename(process.argv[1]) === 'cli.ts') {
        throw new Error('Cannot create executable from test-run.sh')
      }
      output += `#!/usr/bin/env -S ${process.argv0} --no-warnings ${process.argv[1]} --syntax=json run\n`
    }
    output += serializeVal(exp)
  } else if (args.executable) {
    // Read prelude but elide the "use strict" line.
    const prelude = preludeJs.slice(preludeJs.indexOf('\n') + 1)
    const names = []
    for (const k of recordKeys<string, unknown>(runtimeContext)) {
      names.push(k)
    }
    output += `import {${names.join(', ')}} from '${path.join(__dirname, '../../lib/ark/data.js')}'\n`
    output += `import {run, spawn} from '${path.join(__dirname, '../../node_modules/effection/esm/mod.js')}'\nlet prelude = ${prelude};
(await (run(prelude))).properties.forEach((val, sym) => jsGlobals.set(sym, val))\n`
    output += `jsGlobals.set('argv', new ArkList(
  [ArkString(process.argv[1]), ...process.argv.slice(2).map((s) => ArkString(s))],
));\n`
    const code = arkToJs(exp, prog).code
    const codeTail = code.slice(code.indexOf('\n') + 1)
    output += `await run${codeTail}\n`
    const tmpFile = tmp.fileSync()
    fs.writeFileSync(tmpFile.name, output)
    output = await buildRuntime(tmpFile.name)
    tmpFile.removeCallback()
    output = `#!/usr/bin/env -S node --experimental-default-type=module --\n${output}`
  } else {
    output += arkToJs(exp, prog).code
  }
  fs.writeFileSync(outputFile, output)
  if (args.executable && typeof outputFile !== 'number') {
    fs.chmodSync(outputFile, 0o775)
  }
}

function fmtCommand(args: Args) {
  const inputFile = getInputFile(args)
  const input = fs.readFileSync(inputFile, {encoding: 'utf-8'})
  const output = format(input, args.indent)
  const outputFile = getOutputFile(args, true)
  fs.writeFileSync(outputFile, output)
  return Promise.resolve()
}

// Execute given commands and options.
if (process.argv.length >= 3) {
  // If our first argument is not a command or option, assume it's a file to run.
  const filename = process.argv[2]
  // The next line accesses a private field of subparsers to get the command names.
  // eslint-disable-next-line max-len
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  if (!filename.startsWith('-') && !new Set(Object.keys((subparsers as any).choices)).has(filename)) {
    process.argv.splice(2, 0, 'run')
  }
}

// Any otherwise uncaught exception is reported as an error.
try {
  const args = parser.parse_args() as Args
  if (args.func) {
    await args.func(args)
  } else {
    // If we have no sub-command, enter REPL.
    await repl(args)
  }
} catch (error) {
  if (process.env.DEBUG) {
    console.error(error)
  } else {
    console.error(`${path.basename(process.argv[1])}: ${error}`)
  }
  process.exitCode = 1
}
