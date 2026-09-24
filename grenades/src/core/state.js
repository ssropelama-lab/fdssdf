// Автомат состояний гранаты:
// готова → клип → чека → рычаг зажат → рычаг отпущен → ударник → замедлитель → взрыв → последствия
export const S = Object.freeze({
  READY: 'ready',
  CLIP: 'clip',          // клип снят (у M84 клипа нет — сразу чека)
  PIN: 'pin',            // чеку тянут
  HELD: 'held',          // чека вынута, рычаг зажат рукой
  RELEASED: 'released',  // рычаг отпущен, летит
  STRIKER: 'striker',    // ударник наколол капсюль
  FUSE: 'fuse',          // горит замедлитель
  BLAST: 'blast',
  AFTER: 'after',
});

const NEXT = {
  ready: ['clip', 'pin'],
  clip: ['pin'],
  pin: ['pin', 'held'],
  held: ['released'],
  released: ['striker'],
  striker: ['fuse'],
  fuse: ['blast'],
  blast: ['after'],
  after: [],
};

export const LABEL = {
  ready: 'Готова · предохранители на месте',
  clip: 'Клип снят',
  pin: 'Чека…',
  held: 'Чека вынута · рычаг зажат',
  released: 'Рычаг отпущен',
  striker: 'Ударник · капсюль',
  fuse: 'Горит замедлитель',
  blast: 'Взрыв',
  after: 'Последствия',
};

export class GrenadeState {
  constructor(hasClip) {
    this.hasClip = hasClip;
    this.listeners = [];
    this.reset();
  }
  reset() {
    this.phase = this.hasClip ? S.READY : S.CLIP;
    this.t = {};           // время входа в каждую фазу (секунды часов приложения)
    this.inHand = true;
    this.thrown = false;
  }
  can(to) { return NEXT[this.phase].includes(to); }
  go(to, now) {
    if (!this.can(to)) return false;
    const from = this.phase;
    this.phase = to;
    this.t[to] = now;
    for (const f of this.listeners) f(to, from, now);
    return true;
  }
  on(f) { this.listeners.push(f); }
  is(...ph) { return ph.includes(this.phase); }
  get armed() { return this.is(S.RELEASED, S.STRIKER, S.FUSE); }
  get pinOut() { return !this.is(S.READY, S.CLIP, S.PIN); }
}
