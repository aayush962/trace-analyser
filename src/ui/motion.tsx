import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { C } from './theme.js';

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
