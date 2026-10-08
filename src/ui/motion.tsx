import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { C } from './theme.js';
import stringWidth from 'string-width';
import { cell, windowCells } from './format.js';
import { singleLine } from '../core/safe.js';

/** A focused long title gets one gentle pan, then rests. No whole-table animation. */
export function Marquee({ text, width, active, reduced = false }: { text: string; width: number; active: boolean; reduced?: boolean }) {
  const value = singleLine(text);
  const max = Math.max(0, stringWidth(value) - width);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
    if (!active || reduced || max <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    let step = 0;
    let direction = 1;
    const tick = () => {
      step += direction;
      setOffset(step);
      if (step === max) { direction = -1; timer = setTimeout(tick, 1700); }
      else if (step > 0) timer = setTimeout(tick, 90);
    };
    timer = setTimeout(tick, 1100);
    return () => clearTimeout(timer);
  }, [value, width, max, active, reduced]);
  return <Text>{active && !reduced && offset > 0 ? windowCells(value, Math.min(offset, max), width) : cell(value, width)}</Text>;
}

/** Motion is restricted to a tiny active region; idle screens have no animation timer. */
export function Activity({ label, reduced = false }: { label: string; reduced?: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => setFrame(value => (value + 1) % 8), 120);
    return () => clearInterval(timer);
  }, [reduced]);
  return <Text color={C.accent}>{reduced ? '·' : ['·', '∙', '•', '✦', '✧', '✦', '•', '∙'][frame]} {label}</Text>;
}

export function Entrance({ children, reduced = false }: { children: React.ReactNode; reduced?: boolean }) {
  const [settled, setSettled] = useState(reduced);
  useEffect(() => {
    if (reduced) { setSettled(true); return; }
    const timer = setTimeout(() => setSettled(true), 120);
    return () => clearTimeout(timer);
  }, [reduced]);
  // One short emphasis transition; content is never delayed or typewritten.
  return <Text dimColor={!settled}>{children}</Text>;
}
