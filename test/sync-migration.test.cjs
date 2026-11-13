const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { isDeepStrictEqual } = require('node:util')

// Exercise the actual methods without importing native addons, starting torrents,
// opening a user database, loading profiles, or contacting external services.
const source = readFileSync(join(__dirname, '../client/core/webtorrent.js'), 'utf8')
const cacheSource = readFileSync(join(__dirname, '../common/modules/cache.js'), 'utf8')
const methodStart = source.indexOf('  setMedia(hash, data, overwrite = true) {')
const methodEnd = source.indexOf('\n  /**', methodStart)
assert.ok(methodStart > 0 && methodEnd > methodStart)
const Factory = vm.runInNewContext(`(class ReviewedMethod { ${source.slice(methodStart, methodEnd)} })`, {
  isDeepStrictEqual, debug: () => {}, makeHash: () => '', stripRootFolder: path => path
})

function client({ failWrite = false, wrongReadback = false, missing = false } = {}) {
  let saved = missing ? null : { info: {}, media: {}, files: [] }
  const item = new Factory()
  Object.assign(item, {
    client: { torrents: [] }, removals: new Map(), mediaWrites: new Map(), completed: [],
    torrentCache: {
      cacheFolder: Promise.resolve(),
      get: async () => saved,
      set: async (hash, data) => {
        if (failWrite) throw new Error('disk full')
        if (!wrongReadback) saved = data
      }
    }
  })
  return item
}

function migration(item) {
  let removed = false
  const history = {
    get: () => Promise.resolve({ value: [{ hash: 'hash', mediaId: 42 }] }),
    count: () => {
      const request = {}
      setImmediate(() => request.onsuccess?.())
      return request
    },
    delete: () => {
      removed = true
      const request = {}
      setImmediate(() => request.onsuccess?.())
      return request
    }
  }
  const start = cacheSource.indexOf('function UPGRADE_V2_TO_V3(')
  const end = cacheSource.indexOf('\n/**', start)
  assert.ok(start > 0 && end > start)
  const upgrade = vm.runInNewContext(`(${cacheSource.slice(start, end)})`, {
    caches: { HISTORY: { key: 'history' }, GENERAL: { key: 'general' }, MEDIA_CACHE: {} },
    wrapRequest: request => request, migrationStatus: { set: () => {} },
    get: async () => null, SHARED_DB_NAME: 'shared', generalDefaults: { settings: {} },
    getTorrentSettings: settings => settings, localStorage: { getItem: () => '' },
    TORRENT: { portRequest: async () => {}, reload: () => {}, setMedia: (...args) => item.setMedia(...args) }
  })
  const transaction = { objectStore: key => key === 'history' ? history : { get: () => Promise.resolve(null) } }
  return { run: () => upgrade({ name: 'isolated-test' }, transaction, Promise.resolve()), wasRemoved: () => removed }
}

test('failed destination write rejects the upgrade and retains legacy metadata', async () => {
  const state = migration(client({ failWrite: true }))
  await assert.rejects(state.run(), /disk full/)
  assert.equal(state.wasRemoved(), false)
})

test('unverified destination readback rejects the upgrade and retains legacy metadata', async () => {
  const state = migration(client({ wrongReadback: true }))
  await assert.rejects(state.run(), /Could not save torrent media/)
  assert.equal(state.wasRemoved(), false)
})

test('verified destination persistence still completes the upgrade', async () => {
  const state = migration(client())
  await state.run()
  assert.equal(state.wasRemoved(), true)
})

test('ordinary saves continue to reject destination write errors', async () => {
  await assert.rejects(client({ failWrite: true }).setMedia('HASH', { anilist_id: 42 }), /disk full/)
})

test('migration still skips an entry whose torrent cache no longer exists', async () => {
  const result = await client({ missing: true }).setMedia('HASH', { anilist_id: 42 }, false)
  assert.equal(Object.keys(result).length, 0)
})

// Run the component's saved-media reuse and fallback classification without Svelte,
// profiles, network lookups, torrent startup, or application imports.
const handlerSource = readFileSync(join(__dirname, '../common/components/MediaHandler.svelte'), 'utf8')
const reuseStart = handlerSource.indexOf('    const parsedFiles =', handlerSource.indexOf('// Reuse each file'))
const reuseEnd = handlerSource.indexOf('    if (uncachedMedia?.length)', reuseStart)
assert.ok(reuseStart > 0 && reuseEnd > reuseStart)
async function classifySaved(files, requestMedia) {
  const classify = vm.runInNewContext(`(async function(videoFiles) {
    ${handlerSource.slice(reuseStart, reuseEnd)}
    return uncachedMedia
  })`, { cache: { requestMedia }, anitomyscript: async () => [], debug: () => {} })
  return classify(files)
}

test('failed saved media lookup falls back to the normal file resolver', async () => {
  const file = { name: 'episode.mkv', mediaData: { anilist_id: 42 } }
  const unresolved = await classifySaved([file], async () => { throw new Error('offline') })
  assert.equal(unresolved[0], file)
  assert.equal(file.media, undefined)
})

test('missing saved media falls back to the normal file resolver', async () => {
  const file = { name: 'episode.mkv', mediaData: { anilist_id: 42 } }
  const unresolved = await classifySaved([file], async () => null)
  assert.equal(unresolved[0], file)
  assert.equal(file.media, undefined)
})

test('verified saved media retains its episode metadata and skips duplicate resolution', async () => {
  const file = { name: 'episode.mkv', mediaData: { anilist_id: 42, episode: 3 } }
  const unresolved = await classifySaved([file], async () => ({ id: 42 }))
  assert.equal(unresolved.length, 0)
  assert.equal(file.media.media.id, 42)
  assert.equal(file.media.parseObject.episode_number, 3)
})

test('a failed saved lookup preserves an already resolved valid mapping', async () => {
  const mapping = { media: { id: 42 }, episode: 3 }
  const file = { name: 'episode.mkv', mediaData: { anilist_id: 42 }, media: mapping }
  const unresolved = await classifySaved([file], async () => null)
  assert.equal(unresolved.length, 0)
  assert.equal(file.media, mapping)
})
