import '@fontsource/luckiest-guy/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './styles.css';
import { Game } from './game/Game';

/** Boot: load fonts (canvas textures need them), init physics, build the world, show the menu. */
async function boot() {
  const bar = document.getElementById('loaderBar')!;
  const text = document.getElementById('loaderText')!;
  const progress = (k: number, t: string) => {
    bar.style.width = `${Math.round(k * 100)}%`;
    text.textContent = t;
  };
  progress(0.02, 'Chargement des polices…');
  try {
    await Promise.race([document.fonts.load('76px "Luckiest Guy"'), new Promise((r) => setTimeout(r, 2500))]);
  } catch {
    /* fall back to system fonts */
  }
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  try {
    const game = await Game.create(canvas, progress);
    setTimeout(() => game.showMenu(), 250);
  } catch (err) {
    console.error(err);
    progress(1, `Erreur au démarrage : ${(err as Error).message}`);
  }
}

boot();
