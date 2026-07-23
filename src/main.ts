import { App } from './core/app';

new App().start(document.body).catch((err: unknown) => {
  console.error('init failed', err);
});
