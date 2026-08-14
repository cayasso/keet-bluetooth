const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')

const BLETransport = require('./lib/transport')

function loadBackend() {
  try {
    return require('bare-bluetooth')
  } catch {
    return null // no BLE backend on this platform → 'unsupported'
  }
}

/**
 * Hyperswarm-shaped swarm over Bluetooth LE. Construct once and toggle with
 * start()/stop() — the underlying radio managers are created a single time and
 * suspended/resumed, never destroyed.
 *
 * @example
 * const bt = new BluetoothSwarm({ keyPair, topic })
 * bt.on('connection', (conn) => { ... }) // NoiseSecretStream, deduped
 * await bt.start()
 */
module.exports = class BluetoothSwarm extends ReadyResource {
  constructor(opts = {}) {
    super()
    this.started = false
    this.transport = null
    this._opts = opts
    this._backend = opts.backend !== undefined ? opts.backend : loadBackend()
    this._online = opts.online === true
  }

  get supported() {
    return this._backend !== null
  }

  get state() {
    if (!this.supported) return 'unsupported'
    if (!this.started || !this.transport) return 'off'
    return this.transport.state
  }

  get peers() {
    return this.transport ? this.transport.linkCount : 0
  }

  // live NoiseSecretStreams, hyperswarm-style
  get connections() {
    return this.transport ? this.transport.peers.values() : [].values()
  }

  status() {
    return { state: this.state, peers: this.peers }
  }

  async start() {
    if (!this.supported || this.started || this.closing || this.closed) return
    this.started = true
    if (this.transport) {
      this.transport.resume()
    } else {
      this.transport = this._createTransport()
      await this.transport.ready()
    }
    this.emit('update')
  }

  _createTransport() {
    const transport = new BLETransport({
      ...this._opts,
      backend: this._backend,
      online: this._online,
      onconnection: (conn) => this.emit('connection', conn)
    })
    transport.on('update', () => this.emit('update'))
    transport.on('radio-cycled', () => this._rebuild(transport))
    return transport
  }

  // A radio power cycle wedges the surviving native managers — abandon them
  // (never destroy: native double-free) and start over with fresh ones.
  async _rebuild(old) {
    if (this.transport !== old || this.closing || this.closed) return
    old.suspend().catch(safetyCatch)
    this.transport = null
    if (this.started) {
      this.transport = this._createTransport()
      await this.transport.ready().catch(safetyCatch)
    }
    this.emit('update')
  }

  async stop() {
    if (!this.started) return
    this.started = false
    if (this.transport) await this.transport.suspend()
    this.emit('update')
  }

  // Hint from the host: relax scanning while the internet path is up
  setOnline(online) {
    this._online = online === true
    if (this.transport) this.transport.setOnline(this._online)
  }

  async _close() {
    this.started = false
    if (this.transport) await this.transport.close()
  }
}

module.exports.toServiceUUID = BLETransport.toServiceUUID
