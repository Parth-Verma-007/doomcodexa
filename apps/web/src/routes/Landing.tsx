import { Link } from 'react-router-dom';
import { Code2, Play, ShieldCheck, Terminal, Users, Zap } from 'lucide-react';
import { LANGUAGE_LIST } from '@codexa/shared';
import { SignedIn, SignedOut } from '../lib/auth.js';
import { Button } from '../components/Button.js';
import { StarButton } from '../components/StarButton.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { ArrowRevealButton } from '../components/ArrowRevealButton.js';
import { LanguageCarousel } from '../components/LanguageCarousel.js';
import TextMatrixRain from '../components/TextMatrixRain.js';
import { GradientBloom } from '../components/decor/GradientBloom.js';
import { GridMesh } from '../components/decor/GridMesh.js';
import { FramedPanel } from '../components/decor/FramedPanel.js';
import { cn } from '../lib/utils.js';

export function Landing() {
  return (
    <div className="relative h-full overflow-y-auto bg-surface-0">
      {/* Fixed to the viewport so the bloom stays put while content scrolls. */}
      <div className="pointer-events-none fixed inset-0">
        <GridMesh size={34} />
        <GradientBloom />
      </div>

      <div className="relative">
        <Header />

        <main className="mx-auto max-w-6xl px-6">
          <Hero />
          <EditorPreview />
          <Features />
          <HowItWorks />
          <ClosingCta />
        </main>

        <footer className="mx-auto mt-20 max-w-6xl px-6 pb-10">
          <div className="codexa-rule mb-6" />
          <div className="flex flex-col items-center justify-between gap-3 text-sm text-ink-faint sm:flex-row">
            <span className="flex items-center gap-2">
              <Code2 size={15} className="text-accent" />
              Codexa — a collaborative IDE.
            </span>
            <span>C · C++ · Java · Python</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-20">
      <div className="mx-auto max-w-6xl px-6 py-4">
        <div className="codexa-glass flex items-center justify-between rounded-xl px-4 py-2.5">
          <span className="flex items-center gap-2 font-semibold">
            <Code2 size={18} className="text-accent" />
            Codexa
          </span>
          <nav className="flex items-center gap-2">
            <ThemeToggle />
            <SignedOut>
              <Link to="/sign-in">
                <Button variant="ghost" size="sm">
                  Sign in
                </Button>
              </Link>
              <Link to="/sign-up">
                <Button variant="primary" size="sm" sheen>
                  Get started
                </Button>
              </Link>
            </SignedOut>
            <SignedIn>
              <Link to="/dashboard">
                <Button variant="primary" size="sm" sheen>
                  Open dashboard
                </Button>
              </Link>
            </SignedIn>
          </nav>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="py-20 text-center sm:py-28">
      <span className="codexa-glass mb-6 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs text-ink-muted">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-70" />
          <span className="relative inline-flex size-1.5 rounded-full bg-success" />
        </span>
        Conflict-free editing, powered by a CRDT
      </span>

      {/*
        Two texts, one heading. Each line is its own block and scrambles in as
        its own wave, so the break is deliberate rather than whatever the line
        breaker happens to choose at a given width. They stay inside a single
        <h1> — two headings would claim the page has two titles.

        Pink is the *effect* only. Each character churns in pink and flares pink
        as it lands, then the component clears its inline colour and the run's
        own styling takes over — so the settled heading is exactly the ink and
        accent gradient it always was.

        The second line's gradient is applied through `segments` rather than to
        the block itself: the segment's wrapper is an inline span sized to the
        text, so `bg-clip-text` paints across the words instead of across the
        full centred line.
      */}
      <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl">
        <TextMatrixRain as="span" className="block">
          Code together
        </TextMatrixRain>
        <TextMatrixRain
          as="span"
          segments={[
            {
              text: 'actually together.',
              className:
                'bg-[linear-gradient(100deg,var(--color-accent),#9c6bff_55%,#21b8a6)] bg-clip-text text-transparent',
            },
          ]}
          className="block"
        >
          actually together.
        </TextMatrixRain>
      </h1>

      <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-ink-muted">
        A collaborative IDE for C, C++, Java and Python. Every keystroke syncs live, cursors move
        where your teammates are looking, and you can run the program — with real keyboard input —
        without leaving the browser.
      </p>

      <div className="mt-9 flex flex-wrap justify-center gap-3">
        <SignedOut>
          <Link to="/sign-up">
            <StarButton>Start coding free</StarButton>
          </Link>
          <Link to="/sign-in">
            <Button variant="glass" size="lg">
              Sign in
            </Button>
          </Link>
        </SignedOut>
        <SignedIn>
          <ArrowRevealButton to="/dashboard">Go to your projects</ArrowRevealButton>
        </SignedIn>
      </div>

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {LANGUAGE_LIST.map((language) => (
          <span
            key={language.id}
            className="codexa-glass rounded-full px-3 py-1 text-sm text-ink-muted"
          >
            {language.label}
          </span>
        ))}
      </div>
    </section>
  );
}

/**
 * The product, drawn in markup rather than shipped as screenshots.
 *
 * Four faces of a rotating prism, one per language, each an editor and its run
 * output. Markup rather than images means it stays sharp at any density,
 * follows the theme, weighs nothing, and cannot go stale when the real UI
 * changes.
 */
function EditorPreview() {
  return (
    <section className="pb-8">
      <LanguageCarousel />
    </section>
  );
}

function Features() {
  const items = [
    {
      icon: <Users size={18} />,
      title: 'Real-time, conflict-free',
      body: 'Built on a CRDT, so two people typing in the same line never lose a character — and edits made while your connection drops merge cleanly when it returns.',
    },
    {
      icon: <Terminal size={18} />,
      title: 'Programs that read input',
      body: 'Keystrokes go straight to the running program, so scanf, Scanner and input() block and read the way they do in your own terminal.',
    },
    {
      icon: <ShieldCheck size={18} />,
      // Deliberately not called "sandboxed". Runs are child processes of the
      // API, so there is no container and no network isolation — claiming
      // otherwise on the landing page would be a false security claim.
      title: 'Bounded execution',
      body: 'Every run gets a fresh scratch workspace, a wall-clock limit, a killed process tree and an output cap — then cleans up after itself.',
    },
    {
      icon: <Zap size={18} />,
      title: 'Voice built in',
      body: 'Talk and share your screen while you work. Media is peer-to-peer, so it never touches our servers.',
    },
  ];

  return (
    <section className="py-16">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <article
            key={item.title}
            className={cn(
              'group rounded-xl border border-border bg-surface-1/60 p-5 backdrop-blur-sm',
              'transition-colors hover:border-border-strong hover:bg-surface-1',
            )}
          >
            <span className="mb-3 inline-flex rounded-lg bg-accent/12 p-2 text-accent transition-transform group-hover:scale-110">
              {item.icon}
            </span>
            <h2 className="mb-1.5 font-semibold">{item.title}</h2>
            <p className="text-sm leading-relaxed text-ink-muted">{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: '01',
      title: 'Create a project',
      body: 'Pick a language. It starts with a program that already runs.',
    },
    {
      n: '02',
      title: 'Share the link',
      body: 'Choose whether people can edit or only read. Revoke it whenever.',
    },
    {
      n: '03',
      title: 'Press Run',
      body: 'Compile and execute in a sandbox. Everyone sees the same terminal.',
    },
  ];

  return (
    <section className="py-8">
      <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight">
        Sixty seconds from link to running code
      </h2>

      <div className="grid gap-4 sm:grid-cols-3">
        {steps.map((step) => (
          <FramedPanel key={step.n} className="p-5">
            <span className="font-mono text-xs text-accent">{step.n}</span>
            <h3 className="mt-2 font-medium">{step.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-ink-muted">{step.body}</p>
          </FramedPanel>
        ))}
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="py-16">
      <div className="codexa-glass relative overflow-hidden rounded-2xl px-6 py-14 text-center">
        <GridMesh size={26} fade="radial" className="opacity-60" />
        <div className="relative">
          {/* `as="h2"` keeps this a heading — the component renders a div by
              default, which would quietly drop a level from the outline. */}
          <TextMatrixRain
            as="h2"
            repeat={false}
            className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            Open a project. Send one link.
          </TextMatrixRain>
          <p className="mx-auto mt-3 max-w-lg text-pretty text-ink-muted">
            No installs, no toolchain, no “works on my machine”. Your teammate does not even need a
            compiler.
          </p>
          <div className="mt-7 flex justify-center">
            <SignedOut>
              <Link to="/sign-up">
                <StarButton>
                  <Play size={16} />
                  Start coding free
                </StarButton>
              </Link>
            </SignedOut>
            <SignedIn>
              <ArrowRevealButton to="/dashboard">Go to your projects</ArrowRevealButton>
            </SignedIn>
          </div>
        </div>
      </div>
    </section>
  );
}
