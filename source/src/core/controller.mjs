import { emptyConfig, validateConfig } from './config.mjs';

export const STORAGE_KEY = 'mockroute.configuration.v1';
const ACTIVITY_KEY = 'mockroute.activity.v1';
const activityLimit = 100;

export class Controller {
  constructor({ storage, platform }) {
    this.storage = storage;
    this.platform = platform;
    this.activity = [];
    this.configRevision = crypto.randomUUID();
    this.activitySession = crypto.randomUUID();
    this.activityCount = 0;
    this.activityWrite = Promise.resolve();
    this.message = '';
    this.queue = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    await Promise.all([this.loadConfig(), this.loadActivity()]);
  }

  async loadConfig() {
    try {
      const stored = await this.storage.get(STORAGE_KEY);
      this.config = validateConfig(stored ?? emptyConfig());
    } catch {
      this.config = emptyConfig();
      this.message = 'Saved scenarios could not be loaded. Export a backup before replacing them.';
    }
  }

  async loadActivity() {
    try {
      const stored = await this.storage.get(ACTIVITY_KEY);
      if (Array.isArray(stored)) this.activity = stored.slice(0, activityLimit);
    } catch { /* Activity remains available for the current session. */ }
  }

  persistActivity() {
    const rows = this.activity.slice();
    const next = this.activityWrite.then(() => this.storage.set(ACTIVITY_KEY, rows));
    this.activityWrite = next.catch(() => {});
    return next;
  }

  dispatch(action, data = {}) {
    if (action === 'state') return this.ready.then(() => this.state(data));
    const next = this.queue.then(async () => {
      await this.ready;
      return this.change(action, data);
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async change(action, data) {
    switch (action) {
      case 'save': {
        if (data.revision !== this.configRevision) throw new Error('Scenarios changed in another panel. Refresh before saving.');
        const config = validateConfig(data.config);
        await this.storage.set(STORAGE_KEY, config);
        this.config = config;
        this.configRevision = crypto.randomUUID();
        this.message = '';
        break;
      }
      case 'start': {
        await this.platform.start(data, () => this.config, row => {
          this.activity.unshift(row);
          if (this.activity.length > activityLimit) this.activity.pop();
          this.activityCount++;
          void this.persistActivity().catch(() => {});
        });
        this.message = '';
        break;
      }
      case 'stop':
        await this.platform.stop();
        this.message = '';
        break;
      case 'clear':
        this.activity = [];
        this.activityCount++;
        await this.persistActivity();
        break;
      default:
        throw new Error('Unknown Mockend action.');
    }
    return this.state();
  }

  async state({ revision, activityVersion } = {}) {
    const connection = await this.platform.state();
    const version = `${this.activitySession}:${this.activityCount}`;
    return {
      revision: this.configRevision, connection, message: this.message, activityVersion: version,
      ...(revision === this.configRevision ? {} : { config: this.config }),
      ...(activityVersion === version ? {} : { activity: this.activity })
    };
  }
}
