var _ = require( 'lodash' );
var when = require( 'when' );
var machina = require( 'machina' )( _ );
var Monologue = require( 'monologue.js' )( _ );
var publishLog = require( './publishLog' );
var exLog = require( './log.js' )( 'wascally:exchange' );

var Channel = function( options, connection, topology, channelFn ) {

	// allows us to optionally provide a mock
	channelFn = channelFn || require( './amqp/exchange' );

	var Fsm = machina.Fsm.extend( {
		name: options.name,
		type: options.type,
		channel: undefined,
		handlers: [],
		published: publishLog(),

		_define: function( stateOnDefined ) {
			this.channel.define()
				.then( function() {
					this.transition( stateOnDefined );
				}.bind( this ) )
				.then( null, function( err ) {
					this.failedWith = err;
					this.transition( 'failed' );
				}.bind( this ) );
		},

		_listen: function() {
			this.handlers.push( topology.on( 'bindings-completed', function() {
				this.handle( 'bindings-completed' );
			}.bind( this ) ) );
			this.handlers.push( connection.on( 'reconnected', function() {
				this.transition( 'reconnecting' );
			}.bind( this ) ) );
		},

		check: function() {
			return when.promise( function( resolve, reject ) {
				this.on( 'defined', function() {
					resolve();
				} ).once();
				this.on( 'failed', function( err ) {
					reject( err );
				} ).once();
				this.handle( 'check' );
			}.bind( this ) );
		},

		destroy: function() {
			exLog.debug( 'Destroy called on exchange %s - %s (%d messages pending)', this.name, connection.name, this.published.count() );
			this.transition( 'destroying' );
			return this.channel.destroy()
				.then( function() {
					this.transition( 'destroyed' );
				}.bind( this ) );
		},

		publish: function( message ) {
			var deferred = when.defer();
			exLog.info( 'Publish called in state', this.state );
			var op = function() {
				return this.channel.publish( message )
					.then( function() {
						deferred.resolve();
					} )
					.then( null, function( e ) {
						deferred.reject( e );
					} );
			}.bind( this );
			this.on( 'failed', function( err ) {
				deferred.reject( err );
			} ).once();
			this.handle( 'publish', op );
			return deferred.promise;
		},

		republish: function() {
			var undelivered = this.published.reset();
			if ( undelivered.length > 0 ) {
				var promises = _.map( undelivered, this.channel.publish.bind( this.channel ) );
				return when.all( promises );
			} else {
				return when( true );
			}
		},

		initialState: 'setup',
		states: {
			'setup': {
				_onEnter: function() {
					this._listen();
					this.transition( 'initializing' );
				}
			},
			'destroying': {
				publish: function() {
					this.deferUntilTransition( 'destroyed' );
				}
			},
			'destroyed': {
				_onEnter: function() {
					if ( this.published.count() > 0 ) {
						exLog.warn( '%s exchange %s - %s was destroyed with %d messages unconfirmed',
							this.type,
							this.name,
							connection.name,
							this.published.count() );
					}
					_.each( this.handlers, function( handle ) {
						handle.unsubscribe();
					} );
					this.channel = undefined;
				},
				'bindings-completed': function() {
					this.deferUntilTransition( 'reconnected' );
				},
				check: function() {
					this.deferUntilTransition( 'ready' );
				},
				publish: function() {
					this.transition( 'reconnecting' );
					this.deferUntilTransition( 'ready' );
				}
			},
			'initializing': {
				_onEnter: function() {
					this.channel = channelFn( options, topology, this.published );
					this.channel.channel.once( 'released', function() {
						this.handle( 'released' );
					}.bind( this ) );
					this._define( 'ready' );
				},
				check: function() {
					this.deferUntilTransition( 'ready' );
				},
				released: function() {
					this.transition( 'initializing' );
				},
				publish: function() {
					this.deferUntilTransition( 'ready' );
				}
			},
			'failed': {
				_onEnter: function() {
					this.emit( 'failed', this.failedWith );
					this.channel = undefined;
				},
				check: function() {
					this.emit( 'failed', this.failedWith );
				},
				publish: function() {
					this.emit( 'failed', this.failedWith );
				}
			},
			'ready': {
				_onEnter: function() {
					this.emit( 'defined' );
				},
				check: function() {
					this.emit( 'defined' );
				},
				released: function() {
					this.transition( 'initializing' );
				},
				publish: function( op ) {
					op();
				}
			},
			'reconnecting': {
				_onEnter: function() {
					this._listen();
					this.channel = channelFn( options, topology, this.published );
					this._define( 'reconnected' );
				},
				'bindings-completed': function() {
					this.deferUntilTransition( 'reconnected' );
				},
				check: function() {
					this.deferUntilTransition( 'ready' );
				},
				publish: function() {
					this.deferUntilTransition( 'ready' );
				}
			},
			'reconnected': {
				_onEnter: function() {
					this.emit( 'defined' );
				},
				'bindings-completed': function() {
					this.republish()
						.then( function() {
							this.transition( 'ready' );
						}.bind( this ) )
						.then( null, function( err ) {
							exLog.error( 'Failed to republish %d messages on %s exchange, %s - %s with: %s',
								this.published.count(),
								this.type,
								this.name,
								connection.name,
								err );
						}.bind( this ) );
				},
				check: function() {
					this.deferUntilTransition( 'ready' );
				},
				publish: function() {
					this.deferUntilTransition( 'ready' );
				},
				released: function() {
					this.transition( 'initializing' );
				},
			}
		}
	} );

	Monologue.mixin( Fsm );
	var fsm = new Fsm();
	connection.addExchange( fsm );
	return fsm;
};

module.exports = Channel;
