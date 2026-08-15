import { describe, expect, it } from 'vitest';
import type { RunEvent, RunSpec } from '@codexa/shared';
import { LocalExecutionEngine } from './localEngine.js';

/**
 * The execution engine.
 *
 * The interesting cases are the two ends: a language whose toolchain is present
 * must actually compile and run, and one whose toolchain is absent must produce
 * a sentence that names the fix rather than a bare failure. Which languages are
 * present depends on the machine, so the happy path adapts — on CI (Ubuntu with
 * build-essential, a JDK and python3) it exercises all of them; on a laptop with
 * only a JDK it exercises Java and says so.
 */

function collect(): { sink: (e: RunEvent) => void; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { sink: (e) => events.push(e), events };
}

const exitOf = (events: RunEvent[]) =>
  events.find((e) => e.type === 'exit') as Extract<RunEvent, { type: 'exit' }> | undefined;

const stdoutOf = (events: RunEvent[]) =>
  events
    .filter((e) => e.type === 'stdout')
    .map((e) => (e as Extract<RunEvent, { type: 'stdout' }>).chunk)
    .join('');

const spec = (over: Partial<RunSpec>): RunSpec => ({
  runId: `test-${Math.random().toString(36).slice(2)}`,
  projectId: 'p1',
  language: 'python',
  entrypoint: '/main.py',
  files: [],
  interactive: false,
  ...over,
});

describe('local execution engine', () => {
  it('reports a missing toolchain with an instruction, not a bare failure', async () => {
    // Deliberately not initialised: no toolchain has been discovered, which is
    // the same state a machine without compilers ends up in.
    const engine = new LocalExecutionEngine();
    const { sink, events } = collect();

    await engine.run(spec({ language: 'cpp', entrypoint: '/main.cpp' }), sink);

    const exit = exitOf(events);
    expect(exit?.status).toBe('failed');
    expect(exit?.reason).toMatch(/C\+\+/);
    // The whole point: it says what to do about it.
    expect(exit?.reason).toMatch(/Install/i);
  });

  it('is unavailable, with a reason, when nothing is installed', () => {
    const engine = new LocalExecutionEngine();
    expect(engine.isAvailable()).toBe(false);
    expect(engine.unavailableReason()).toBeTruthy();
  });

  it('compiles and runs whatever this machine actually has', async () => {
    const engine = new LocalExecutionEngine();
    await engine.initialise();

    const programs: Array<{ spec: RunSpec; expected: string }> = [];

    if (engine.supports('python')) {
      programs.push({
        spec: spec({
          language: 'python',
          entrypoint: '/main.py',
          files: [{ path: '/main.py', content: 'print("py", 6 * 7)\n' }],
        }),
        expected: 'py 42',
      });
    }

    if (engine.supports('java')) {
      programs.push({
        spec: spec({
          language: 'java',
          entrypoint: '/Main.java',
          files: [
            {
              path: '/Main.java',
              content:
                'public class Main { public static void main(String[] a) { System.out.println("java " + (6 * 7)); } }\n',
            },
          ],
        }),
        expected: 'java 42',
      });
    }

    if (engine.supports('cpp')) {
      programs.push({
        spec: spec({
          language: 'cpp',
          entrypoint: '/main.cpp',
          files: [
            {
              path: '/main.cpp',
              content:
                '#include <iostream>\nint main(){ std::cout << "cpp " << 6*7 << std::endl; }\n',
            },
          ],
        }),
        expected: 'cpp 42',
      });
    }

    if (programs.length === 0) {
      // Not a silent skip: an empty run should be visible in the output.
      console.warn('no toolchains on this machine — execution path not exercised');
      expect(engine.isAvailable()).toBe(false);
      return;
    }

    for (const program of programs) {
      const { sink, events } = collect();
      const handle = await engine.run(program.spec, sink);
      await handle.finished;

      const exit = exitOf(events);
      expect(exit?.status, `${program.spec.language}: ${exit?.reason ?? ''}`).toBe('success');
      expect(stdoutOf(events)).toContain(program.expected);
    }

    await engine.shutdown();
  }, 90_000);

  it('feeds stdin to a program that reads it', async () => {
    const engine = new LocalExecutionEngine();
    await engine.initialise();

    // Whichever reader this machine can build. Feeding a program its input is
    // the feature most likely to break silently, so it is worth exercising on
    // any toolchain rather than only where Python happens to be installed.
    const reader = engine.supports('python')
      ? spec({
          language: 'python',
          entrypoint: '/main.py',
          files: [{ path: '/main.py', content: 'print(sum(int(x) for x in input().split()))\n' }],
          stdin: '7 8',
        })
      : engine.supports('java')
        ? spec({
            language: 'java',
            entrypoint: '/Main.java',
            files: [
              {
                path: '/Main.java',
                content:
                  'import java.util.Scanner;\npublic class Main { public static void main(String[] a){ Scanner s = new Scanner(System.in); System.out.println(s.nextInt() + s.nextInt()); } }\n',
              },
            ],
            stdin: '7 8',
          })
        : null;

    if (!reader) {
      console.warn('no toolchain that reads stdin on this machine — path not exercised');
      return;
    }

    const { sink, events } = collect();
    const handle = await engine.run(reader, sink);
    await handle.finished;

    expect(exitOf(events)?.status).toBe('success');
    expect(stdoutOf(events)).toContain('15');

    await engine.shutdown();
  }, 60_000);
});
