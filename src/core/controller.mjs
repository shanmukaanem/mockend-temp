import { emptyConfig, validateConfig } from './config.mjs';
import { readApplications, mergeApplications, splitApplication, followApplication } from './applications.mjs';
import { mapConfigEnvironments } from './environment-rules.mjs';

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
    await this.loadConfig();
    await this.loadActivity();
  }

  async loadConfig() {
    try {
      const stored = await this.storage.get(STORAGE_KEY);
      this.workspace = readApplications(stored);
      this.config = this.workspace.applications.find(app => app.id === this.workspace.activeApplicationId).config;
      if (stored && stored.version !== 2) {
        try {
          if (!await this.storage.get('mockend.legacy-backup.v1')) await this.storage.set('mockend.legacy-backup.v1', stored);
        } catch { /* Loading a valid configuration must not depend on backup writes. */ }
      }
    } catch {
      this.config = emptyConfig();
      this.workspace = readApplications(this.config);
      this.message = 'Saved scenarios could not be loaded. Export a backup before replacing them.';
    }
  }

  async loadActivity() {
    try {
      const stored = await this.storage.get(this.activityKey());
      if (Array.isArray(stored)) this.activity = stored.slice(0, activityLimit);
    } catch { /* Activity remains available for the current session. */ }
  }

  persistActivity() {
    const rows = this.activity.slice();
    const key = this.activityKey();
    const next = this.activityWrite.then(() => this.storage.set(key, rows));
    this.activityWrite = next.catch(() => {});
    return next;
  }

  activityKey() {
    const id = this.workspace.activeApplicationId;
    return id === 'default' ? ACTIVITY_KEY : `${ACTIVITY_KEY}:${id}`;
  }

  dispatch(action, data = {}) {
    if (action === 'state') return this.ready.then(() => this.state(data));
    if (action === 'export-applications') return this.ready.then(() => structuredClone(this.workspace));
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
        const config = validateConfig(mapConfigEnvironments(validateConfig(data.config), { groupIntoActive: true }));
        const workspace = structuredClone(this.workspace);
        workspace.applications.find(app => app.id === workspace.activeApplicationId).config = config;
        await this.storage.set(STORAGE_KEY, readApplications(workspace));
        this.workspace = workspace;
        this.config = config;
        await this.platform.refresh?.();
        this.configRevision = crypto.randomUUID();
        this.message = '';
        break;
      }
      case 'application-follow':
      case 'application-create':
      case 'application-select':
      case 'application-merge':
      case 'application-split':
      case 'applications-import':
      case 'application-rename': {
        if (data.revision !== this.configRevision) throw new Error('Apps changed in another panel. Refresh before switching.');
        const workspace = action === 'applications-import' ? readApplications(data.workspace) : structuredClone(this.workspace);
        const previous = workspace.applications.find(app => app.id === workspace.activeApplicationId);
        const followed = action === 'application-follow' ? followApplication(workspace, data.url) : undefined;
        if (followed && !followed.changed) break;
        if (data.currentUrl && action !== 'application-follow') {
          const current = new URL(data.currentUrl);
          const address = current.origin + current.pathname;
          previous.url = address.length <= 2048 ? address : current.origin;
        }
        if (action === 'application-create') {
          const url = data.url || (data.currentUrl ? previous.url : undefined);
          const app = { id: crypto.randomUUID(), name: data.name, ...(url && { url }), config: emptyConfig() };
          workspace.applications.push(app);
          workspace.activeApplicationId = app.id;
        } else if (action === 'application-merge') mergeApplications(workspace, previous.id, data.id);
        else if (action === 'application-split') splitApplication(workspace, data);
        else if (action === 'application-rename') previous.name = data.name;
        else if (action === 'application-select') {
          workspace.activeApplicationId = data.id;
          const selected = workspace.applications.find(app => app.id === data.id);
          if (selected && !selected.url && data.currentUrl) selected.url = previous.url;
        }
        const validated = readApplications(workspace);
        const switching = action !== 'application-rename' && (action !== 'application-follow' || validated.activeApplicationId !== previous.id);
        if (switching) {
          if (action === 'application-follow' && this.platform.stopMocking) await this.platform.stopMocking();
          else await this.platform.stop();
        }
        await this.storage.set(STORAGE_KEY, validated);
        this.workspace = validated;
        this.config = validated.applications.find(app => app.id === validated.activeApplicationId).config;
        this.configRevision = crypto.randomUUID();
        if (switching) {
          await this.activityWrite;
          this.activity = [];
          await this.loadActivity();
          this.activitySession = crypto.randomUUID();
        }
        this.applicationNotice = followed?.created ? { applicationId: validated.activeApplicationId, name: followed.name, origin: followed.origin } : undefined;
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
        if (data.keepBrowser && this.platform.stopMocking) await this.platform.stopMocking();
        else await this.platform.stop();
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
      followApplications: true, applicationNotice: this.applicationNotice ?? null,
      applicationId: this.workspace.activeApplicationId,
      applications: this.workspace.applications.map(({ id, name, url, origins }) => ({ id, name, ...(url && { url }), ...(origins?.length && { origins }) })),
      ...(revision === this.configRevision ? {} : { config: this.config }),
      ...(activityVersion === version ? {} : { activity: this.activity })
    };
  }
}
