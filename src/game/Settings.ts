import type { QualityLevel } from '../core/Engine';
import type { Difficulty } from '../control/AIController';

export interface Settings {
  difficulty: Difficulty;
  opponent: string;
  quality: QualityLevel;
  layout: 'auto' | 'qwerty' | 'azerty';
  gore: 'blood' | 'confetti';
  sensitivity: number;
  fov: number;
  volume: number;
  music: boolean;
}

const KEY = 'bt.settings.v1';

export function loadSettings(defaults: Partial<Settings>): Settings {
  const base: Settings = {
    difficulty: 'normal',
    opponent: 'random',
    quality: 'high',
    layout: 'auto',
    gore: 'blood',
    sensitivity: 1,
    fov: 80,
    volume: 0.8,
    music: true,
    ...defaults,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...base, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return base;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
