// Render quality: ?quality=low turns off the expensive effects (ambient occlusion, sun shadows, the far
// skyline) for slower GPUs. Anything else is high.
export type Quality = 'high' | 'low';
export const QUALITY: Quality = new URLSearchParams(location.search).get('quality') === 'low' ? 'low' : 'high';

// For comparing looks: ?no=ao,shadows,shade turns single effects off
const off = new Set((new URLSearchParams(location.search).get('no') ?? '').split(','));
export const EFFECTS = {
  ao: QUALITY === 'high' && !off.has('ao'),
  shadows: QUALITY === 'high' && !off.has('shadows'),
  shade: !off.has('shade'),
  far: QUALITY === 'high' && !off.has('far'),
  detail: !off.has('detail'),
  reflections: QUALITY === 'high' && !off.has('reflections'), // live city reflections on the player's car
};
