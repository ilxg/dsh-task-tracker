/**
 * Package entry (package.json "main").
 *
 * The implementation lives in ./host.js so that file can be replaced — or
 * imported under a new module identity — to pick up host-side changes, since
 * Node caches ES modules by URL and the loader row names the file it imports.
 */

export * from './host.js'
