/**
 * Character roster. Looks drive the procedural rig builder; stats drive
 * gameplay (mass → how far you fly, speed, punch power, toughness).
 */

export type Outfit = 'tank' | 'tshirt' | 'tracksuit' | 'cardigan' | 'overalls' | 'hoodie';
export type Hat = 'none' | 'cap' | 'beanie' | 'bun' | 'hair' | 'mohawk';
export type Facial = 'none' | 'mustache' | 'beard';

export interface CharacterLook {
  skin: number;
  shirt: number;
  shirtAccent: number;
  pants: number;
  shoes: number;
  hair: number;
  gloves: number;
  outfit: Outfit;
  hat: Hat;
  hatColor: number;
  facial: Facial;
  glasses: boolean;
  /** 0..1 */
  belly: number;
  /** width multiplier */
  bodyW: number;
  /** height multiplier */
  height: number;
  headScale: number;
  nose: number;
}

export interface CharacterStats {
  /** mass multiplier (1 = 75 kg) */
  mass: number;
  speed: number;
  power: number;
  /** damage taken multiplier (lower is tougher) */
  toughness: number;
}

export interface CharacterDef {
  id: string;
  name: string;
  nickname: string;
  look: CharacterLook;
  stats: CharacterStats;
  /** base voice pitch for synthesized grunts */
  voice: number;
  taunts: string[];
  hurtLines: string[];
  winLines: string[];
}

export const PLAYER_CHARACTER: CharacterDef = {
  id: 'player',
  name: 'TOI',
  nickname: 'Le Challenger',
  look: {
    skin: 0xf0b48c,
    shirt: 0x14a3a0,
    shirtAccent: 0xffd23f,
    pants: 0x2f4a7a,
    shoes: 0xf2f2f2,
    hair: 0x3a2416,
    gloves: 0xe8443a,
    outfit: 'hoodie',
    hat: 'hair',
    hatColor: 0x3a2416,
    facial: 'none',
    glasses: false,
    belly: 0.15,
    bodyW: 1,
    height: 1,
    headScale: 1,
    nose: 1,
  },
  stats: { mass: 1, speed: 1, power: 1, toughness: 1 },
  voice: 150,
  taunts: [],
  hurtLines: [],
  winLines: [],
};

export const ROSTER: CharacterDef[] = [
  {
    id: 'gege',
    name: 'GÉGÉ',
    nickname: '« Le Frigo »',
    look: {
      skin: 0xe8a07a,
      shirt: 0xf3f0e6,
      shirtAccent: 0xd23a3a,
      pants: 0x3b3f4a,
      shoes: 0x2b1d14,
      hair: 0x2b1b12,
      gloves: 0xc8322b,
      outfit: 'tank',
      hat: 'none',
      hatColor: 0x000000,
      facial: 'mustache',
      glasses: false,
      belly: 1,
      bodyW: 1.2,
      height: 1.02,
      headScale: 1.02,
      nose: 1.35,
    },
    stats: { mass: 1.3, speed: 0.88, power: 1.18, toughness: 0.88 },
    voice: 95,
    taunts: ['Viens là, mon p\'tit !', 'Je suis un FRIGO !', 'Ça va saigner !', 'T\'as vu mes biscotos ?', 'Approche, approche...'],
    hurtLines: ['Aïe ma bedaine !', 'Même pas mal !', 'Oh le fourbe !', 'Ma moustache !'],
    winLines: ['Au revoiiir !', 'Bon vol !', 'Et ça, c\'est cadeau !'],
  },
  {
    id: 'kevin',
    name: 'KÉVIN',
    nickname: '« Turbo »',
    look: {
      skin: 0xf2c29a,
      shirt: 0x2a5bd7,
      shirtAccent: 0xffffff,
      pants: 0x2a5bd7,
      shoes: 0xff3d3d,
      hair: 0xd8b04a,
      gloves: 0x1f1f24,
      outfit: 'tracksuit',
      hat: 'cap',
      hatColor: 0xff3d3d,
      facial: 'none',
      glasses: false,
      belly: 0,
      bodyW: 0.86,
      height: 1.04,
      headScale: 0.98,
      nose: 0.85,
    },
    stats: { mass: 0.85, speed: 1.13, power: 0.92, toughness: 1.08 },
    voice: 185,
    taunts: ['Wesh, t\'es lent !', 'Trop rapide pour toi !', 'Tu m\'attrapes pas !', 'Allez, viens !'],
    hurtLines: ['Ouch, wesh !', 'Mon survêt\' !', 'C\'est pas juste !'],
    winLines: ['Byeee !', 'Trop facile !', 'Turbo, bébé !'],
  },
  {
    id: 'paulette',
    name: 'MAMIE PAULETTE',
    nickname: '« La Terreur »',
    look: {
      skin: 0xf3c7aa,
      shirt: 0xe77fb3,
      shirtAccent: 0xfff2f8,
      pants: 0x6c4b8f,
      shoes: 0x2b2030,
      hair: 0xeeeeee,
      gloves: 0xe77fb3,
      outfit: 'cardigan',
      hat: 'bun',
      hatColor: 0xeeeeee,
      facial: 'none',
      glasses: true,
      belly: 0.35,
      bodyW: 0.95,
      height: 0.9,
      headScale: 1.06,
      nose: 1.1,
    },
    stats: { mass: 0.8, speed: 0.97, power: 1.12, toughness: 0.95 },
    voice: 240,
    taunts: ['Viens voir mamie !', 'De mon temps, on se battait mieux !', 'Je vais te tricoter la face !', 'Mange ta soupe !'],
    hurtLines: ['Mon dentier !', 'Petit malpoli !', 'Ma hanche !'],
    winLines: ['Et va te coucher !', 'Mamie 1, toi 0 !', 'Respecte tes aînés !'],
  },
  {
    id: 'dede',
    name: 'DÉDÉ',
    nickname: '« Le Plombier »',
    look: {
      skin: 0xd9946b,
      shirt: 0xe8a33d,
      shirtAccent: 0xf4f1ea,
      pants: 0x3f7a52,
      shoes: 0x4a2c1a,
      hair: 0x4a2a16,
      gloves: 0xf0d24a,
      outfit: 'overalls',
      hat: 'beanie',
      hatColor: 0xe0582c,
      facial: 'beard',
      glasses: false,
      belly: 0.55,
      bodyW: 1.08,
      height: 0.98,
      headScale: 1,
      nose: 1.2,
    },
    stats: { mass: 1.1, speed: 1, power: 1.05, toughness: 0.95 },
    voice: 120,
    taunts: ['Je vais te déboucher !', 'Ça fuit de partout !', 'Viens que je te répare !', 'Clé de 12 !'],
    hurtLines: ['Aïe la tuyauterie !', 'Ça, c\'était pas prévu !', 'Fuite !'],
    winLines: ['Tiré la chasse !', 'Problème réglé !', 'Au tout-à-l\'égout !'],
  },
];
