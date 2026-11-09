import { AssetLoader } from './asset-loader.js';

const ASSET_ACTIONS = new Set(['request_asset', 'place_pending', 'cancel_pending']);
const SCENE_ACTIONS = new Set(['spawn', 'move', 'scale', 'rotate', 'appearance', 'remove']);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Owns conversational asset state and translates planning actions into
 * Asset Resolver calls + Scene Manager commands. No object is selected by default.
 */
export class WorldController {
  constructor({
    sceneManager,
    aimPlacement,
    assetLoader = new AssetLoader(),
    onStateChange = () => {},
    reportEvent = async () => {},
  }) {
    if (!sceneManager) throw new TypeError('WorldController requires a SceneManager.');
    if (!aimPlacement) throw new TypeError('WorldController requires an AimPlacementController.');
    this.sceneManager = sceneManager;
    this.aimPlacement = aimPlacement;
    this.assetLoader = assetLoader;
    this.onStateChange = onStateChange;
    this.reportEvent = reportEvent;
    this.status = 'idle';
    this.pending = null;
    this.pendingTemplate = null;
    this.spawnTemplate = null;
    this.lastPlacedId = null;
    this.error = null;
    this.nextAssetSerial = 1;

    this.sceneManager.registerType('asset', async () => {
      if (!this.spawnTemplate?.isObject3D) {
        throw new Error('Asset spawn is missing a loaded model template.');
      }
      return this.spawnTemplate.clone(true);
    });
  }

  getWorldState() {
    return {
      status: this.status,
      pending: this.pending ? {
        id: this.pending.id,
        name: this.pending.name,
        query: this.pending.query,
        provider: this.pending.provider,
        source_url: this.pending.source_url ?? null,
      } : null,
      lastPlacedId: this.lastPlacedId,
      error: this.error,
    };
  }

  #setState(status, { pending = this.pending, error = null } = {}) {
    this.status = status;
    this.pending = pending;
    this.error = error;
    this.onStateChange(this.getWorldState());
  }

  async executePlan(actions, { requestId }) {
    if (!Array.isArray(actions)) {
      return {
        success: false,
        executed: 0,
        succeeded: 0,
        failed: 1,
        results: [{
          index: -1,
          action: null,
          success: false,
          error: { code: 'INVALID_COMMANDS', message: 'Plan actions must be an array.' },
        }],
        snapshot: this.sceneManager.getSnapshot(),
        world: this.getWorldState(),
      };
    }

    const results = [];
    const sceneBatch = [];
    let sceneStartIndex = 0;

    const flushScene = async () => {
      if (!sceneBatch.length) return;
      const batch = sceneBatch.splice(0, sceneBatch.length);
      const start = sceneStartIndex;
      sceneStartIndex += batch.length;
      const execution = await this.sceneManager.executeCommands(batch);
      for (const item of execution.results) {
        results.push({ ...item, index: start + item.index });
        if (item.success && item.action === 'spawn') {
          this.lastPlacedId = item.objectId;
          this.#setState('placed', { pending: null });
        }
      }
    };

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const kind = action?.action;
      if (ASSET_ACTIONS.has(kind)) {
        await flushScene();
        results.push(await this.#runAssetAction(action, index, requestId));
        continue;
      }
      if (!SCENE_ACTIONS.has(kind)) {
        await flushScene();
        results.push({
          index,
          action: kind ?? null,
          success: false,
          error: { code: 'UNKNOWN_COMMAND', message: `Unsupported command: ${String(kind)}.` },
        });
        continue;
      }
      if (!sceneBatch.length) sceneStartIndex = index;
      sceneBatch.push(this.#rewriteSceneCommand(action));
    }
    await flushScene();

    const succeeded = results.filter((item) => item.success).length;
    return {
      success: succeeded === results.length,
      executed: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
      snapshot: this.sceneManager.getSnapshot(),
      world: this.getWorldState(),
    };
  }

  #rewriteSceneCommand(command) {
    if (!command || typeof command !== 'object') return command;
    if (!['last', 'lastSpawned'].includes(command.target) || !this.lastPlacedId) {
      return command;
    }
    return { ...command, target: this.lastPlacedId };
  }

  async #runAssetAction(action, index, requestId) {
    try {
      if (action.action === 'request_asset') {
        return await this.#requestAsset(action, index, requestId);
      }
      if (action.action === 'place_pending') {
        return await this.#placePending(index);
      }
      if (action.action === 'cancel_pending') {
        return this.#cancelPending(index);
      }
      throw new Error(`Unsupported asset action: ${action.action}`);
    } catch (error) {
      this.#setState('error', {
        pending: this.pending,
        error: error instanceof Error ? error.message : 'Asset action failed.',
      });
      await this.reportEvent({
        request_id: requestId,
        stage: 'asset',
        event: 'action_failed',
        status: 'error',
        metadata: {
          action: action.action,
          error: error instanceof Error ? error.message : String(error),
          world: this.getWorldState(),
        },
      });
      return {
        index,
        action: action.action,
        success: false,
        error: {
          code: 'ASSET_ACTION_FAILED',
          message: error instanceof Error ? error.message : 'Asset action failed.',
        },
      };
    }
  }

  async #requestAsset(action, index, requestId) {
    const query = String(action.query || '').trim();
    if (!query) {
      throw new Error('Asset query cannot be blank.');
    }

    this.aimPlacement.clearPreview();
    this.pendingTemplate = null;
    this.#setState('searching', { pending: null });
    await this.reportEvent({
      request_id: requestId,
      stage: 'state',
      event: 'transition',
      status: 'info',
      metadata: { interaction_status: 'searching', query },
    });

    this.#setState('downloading', { pending: null });
    await this.reportEvent({
      request_id: requestId,
      stage: 'state',
      event: 'transition',
      status: 'info',
      metadata: { interaction_status: 'downloading', query },
    });

    const resolved = await this.assetLoader.resolveAsset(query, requestId);
    await this.reportEvent({
      request_id: requestId,
      stage: 'asset',
      event: 'model_loading',
      status: 'info',
      metadata: {
        asset_id: resolved.id,
        model_url: resolved.model_url,
        cache_hit: resolved.cache_hit,
        provider: resolved.provider,
      },
    });

    const template = await this.assetLoader.loadTemplate(resolved);
    const pending = {
      id: resolved.id,
      name: resolved.name,
      query,
      provider: resolved.provider,
      source_url: resolved.source_url,
      model_url: resolved.model_url,
      format: resolved.format,
      dimensions_mm: resolved.dimensions_mm ?? null,
      cache_hit: resolved.cache_hit,
      place: Boolean(action.place),
    };
    this.pendingTemplate = template;

    if (action.place) {
      const spawned = await this.#spawnPending(pending, template);
      await this.reportEvent({
        request_id: requestId,
        stage: 'asset',
        event: 'placed',
        status: 'success',
        metadata: { asset_id: pending.id, object_id: spawned.objectId },
      });
      return {
        index,
        action: 'request_asset',
        success: true,
        objectId: spawned.objectId,
        asset: cloneJson({
          id: pending.id,
          name: pending.name,
          provider: pending.provider,
          cache_hit: pending.cache_hit,
          placed: true,
        }),
      };
    }

    this.aimPlacement.setPreview(template.clone(true));
    this.#setState('awaiting_placement', { pending });
    await this.reportEvent({
      request_id: requestId,
      stage: 'state',
      event: 'transition',
      status: 'success',
      metadata: {
        interaction_status: 'awaiting_placement',
        asset_id: pending.id,
        asset_name: pending.name,
        cache_hit: pending.cache_hit,
      },
    });
    return {
      index,
      action: 'request_asset',
      success: true,
      asset: cloneJson({
        id: pending.id,
        name: pending.name,
        provider: pending.provider,
        cache_hit: pending.cache_hit,
        placed: false,
      }),
    };
  }

  async #placePending(index) {
    if (!this.pending || !this.pendingTemplate || this.status !== 'awaiting_placement') {
      throw new Error('There is no pending asset ready to place.');
    }
    const pending = this.pending;
    const template = this.pendingTemplate;
    const spawned = await this.#spawnPending(pending, template);
    return {
      index,
      action: 'place_pending',
      success: true,
      objectId: spawned.objectId,
      asset: cloneJson({ id: pending.id, name: pending.name, placed: true }),
    };
  }

  #cancelPending(index) {
    if (!this.pending || this.status !== 'awaiting_placement') {
      throw new Error('There is no pending asset to cancel.');
    }
    const cancelled = this.pending;
    this.aimPlacement.clearPreview();
    this.pendingTemplate = null;
    this.#setState('idle', { pending: null });
    return {
      index,
      action: 'cancel_pending',
      success: true,
      asset: cloneJson({ id: cancelled.id, name: cancelled.name, cancelled: true }),
    };
  }

  async #spawnPending(pending, template) {
    const objectId = `${pending.id}-${this.nextAssetSerial}`;
    this.nextAssetSerial += 1;
    this.spawnTemplate = template;
    let execution;
    try {
      execution = await this.sceneManager.executeCommands([{
        action: 'spawn',
        type: 'asset',
        id: objectId,
        at: 'aim',
        properties: {
          assetId: pending.id,
          assetName: pending.name,
          query: pending.query,
          provider: pending.provider,
          sourceUrl: pending.source_url,
          modelUrl: pending.model_url,
        },
      }]);
    } finally {
      this.spawnTemplate = null;
    }
    if (!execution.success) {
      const message = execution.results[0]?.error?.message ?? 'Could not place the asset.';
      throw new Error(message);
    }
    this.aimPlacement.clearPreview();
    this.pendingTemplate = null;
    this.lastPlacedId = objectId;
    this.#setState('placed', { pending: null });
    return { objectId };
  }
}
