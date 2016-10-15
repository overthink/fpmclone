// Disclaimer: I'm not a game developer and I'm just learning TypeScript, so
// treat this code with extra suspicion.
namespace FMPDemo {

    /** Something sent over the "wire".  Just a marker for now. */
    interface Message {
        seqNum: number;
    }

    /** Input from a client. Gets sent to the server. */
    class Input implements Message {
        seqNum: number;
        pressTime: number;
        entityId: number;
        constructor(seqNum: number, pressTime: number, entityId: number) {
            this.seqNum = seqNum;
            this.pressTime = pressTime;
            this.entityId = entityId;
        }
    }

    /**
     * I don't know the gamedev meaning of this, but here's how I'm viewing it
     * here:  Each client and the server have their own entity objects for
     * everything that is rendered on screen.  The server sends WorldState
     * messages to everyone containing state for all the entities.
     */
    class Entity {
        id: number;
        color: string;
        x: number = 0;
        speed: number = 2;

        constructor(id: number, color: string) {
            this.id = id;
            this.color = color;
        }

        applyInput(input: Input): void {
            this.x += input.pressTime * this.speed;
        }

        /** Return a copy of this entity. */
        copy(): Entity {
            const e = new Entity(this.id, this.color);
            e.x = this.x;
            e.speed = this.speed;
            return e;
        }
    }

    class WorldState implements Message {
        seqNum: number;
        entities: Array<Entity>;

        /** Last input the server has processed from the client to which the
         * WorldState message is sent. */
        lastProcessedInputSeqNums: Array<number>;

        constructor(seqNum: number, entities: Array<Entity>, lastProcessedInputSeqNums: Array<number>) {
            this.seqNum = seqNum;
            this.entities = entities;
            this.lastProcessedInputSeqNums = lastProcessedInputSeqNums;
        }
    }

    class SavedWorldState {
        /**
         * The time at which the client processed this WorldState message.
         */
        processedTs: number;
        value: WorldState;
        constructor(processedTs: number, value: WorldState) {
            this.processedTs = processedTs;
            this.value = value;
        }
    }

    /** Represents a message that has been received by a LagNetwork. */
    class QueuedMessage {
        recvTs: number;
        payload: Message;
    }

    class LagNetwork {
        messages: Array<QueuedMessage> = [];

        /** Returns next message "received" from the network, if any. */
        receive(): QueuedMessage | undefined {
            let now = Date.now();
            for (let i = 0; i < this.messages.length; ++i) {
                var qm = this.messages[i];
                if (qm.recvTs <= now) {
                    this.messages.splice(i, 1);
                    return qm;
                }
            }
        }

        send(lagMs: number, message: Message): void {
            var m = new QueuedMessage;
            m.recvTs = Date.now() + lagMs;
            m.payload = message;
            this.messages.push(m);
        }
    }

    class Client {
        cssId: string; // id of the div containing this client (kind of a hack)
        color: string;
        canvas: HTMLCanvasElement;
        nonAckdInputsElement: Element;
        server?: Server;
        tickRate: number = 60;
        // Why is there `entityId` and also `entity.id`?  Good question.
        // `entityId` is assigned by the server when the connection is made.
        // It is later used to retreive state data for this client from
        // WorldState messages.
        entityId?: number;  // TODO: extremely inconvenient allowing this to have undefined value
        entity?: Entity; // The player's entity in the world; server provides it.
        entities: Array<Entity> = []; // awful, contains reference to this.entity as well
        leftKeyDown: boolean = false;
        rightKeyDown: boolean = false;
        network: LagNetwork = new LagNetwork;
        lagMs: number = 250;
        lastUpdateTs: number = -1;
        inputSeqNum: number = 0;
        pendingInputs: Array<Input> = [];
        curWorldState?: SavedWorldState;  // the last state we received from the server
        prevWorldState?: SavedWorldState; // penultimate state from server, used for entity interpolation
        usePrediction: boolean = false;
        useReconciliation: boolean = false;
        useEntityInterpolation: boolean = false;
        private updateTimer?: number;

        constructor(cssId: string, color: string, canvas: HTMLCanvasElement, nonAckdInputsElement: Element) {
            this.cssId = cssId;
            this.color = color;
            this.canvas = canvas;
            this.nonAckdInputsElement = nonAckdInputsElement;
        }

        processServerMessages(): void {
            while (true) {
                const msg = this.network.receive();
                if (!msg) break;
                const incoming = Util.cast(msg.payload, WorldState);

                for (let i = 0; i < incoming.entities.length; ++i) {
                    const entity = incoming.entities[i];

                    if (this.entityId === undefined) break; // pointless, but tsc unhappy without this

                    if (entity.id === this.entityId) {
                        // entity is the remote state for our local this.entity object

                        // create an entity for ourself if we haven't yet
                        if (!this.entity) {
                            if (typeof this.entityId === 'undefined') {
                                throw new Error(`connected client should always have entityId ${this}`);
                            }
                            this.entity = new Entity(this.entityId, this.color);
                        }

                        // Set our position to whatever was sent by server
                        this.entity.x = entity.x;

                        this.entities[entity.id] = this.entity; // despair

                        if (this.useReconciliation) {
                            // i.e. reapply all inputs not yet ackd by server

                            const lastProcessed = incoming.lastProcessedInputSeqNums[this.entityId];
                            if (lastProcessed) {
                                // First, keep inputs that have not yet been taken
                                // into account by the last WorldState sent by the
                                // server.
                                this.pendingInputs = this.pendingInputs.filter(input => {
                                    return input.seqNum > lastProcessed;
                                });
                            }

                            // apply any remaining inputs to our local world state
                            this.pendingInputs.forEach(input => {
                                if (this.entity) {
                                    this.entity.applyInput(input);
                                }
                            });
                        }

                    } else {
                        // non-local-player entity
                        this.entities[entity.id] = entity;
                    }
                }
                // update prev and current states for later entity interpolation
                this.prevWorldState = this.curWorldState;
                this.curWorldState = new SavedWorldState(Date.now(), incoming);
            }
        }

        processInputs(): void {
            if (this.server === undefined) return;
            if (this.entity === undefined) return;
            if (this.entityId === undefined) return;

            const nowTs: number = Date.now();
            const lastUpdateTs: number = this.lastUpdateTs >= 0 ? this.lastUpdateTs : nowTs;
            const delta: number = (nowTs - lastUpdateTs) / 1000;
            this.lastUpdateTs = nowTs;

            // package up the player's current input
            let input: Input;
            if (this.rightKeyDown) {
                input = new Input(this.inputSeqNum++, delta, this.entityId);
            } else if (this.leftKeyDown) {
                input = new Input(this.inputSeqNum++, -delta, this.entityId);
            } else {
                // nothing interesting happenend
                return;
            }

            this.server.network.send(this.lagMs, input);

            if (this.usePrediction) {
                // optimistically apply our input (assume server will accept it)
                this.entity.applyInput(input);
            }

            if (this.useReconciliation) {
                // Save input for later reconciliation. We'll need to re-apply
                // some of our optimistically applied inputs after we next
                // hear from the server.
                this.pendingInputs.push(input);
            }
        }

        // log only for a specific client (debug)
        // private log(id: number, ...args: any[]): void {
        //     if (this.cssId === 'p' + id.toString()) {
        //         console.log(`${Date.now()} - client p${id}:`, ...args);
        //     }
        // }

        private interpolateEntities(): void {
            if (this.prevWorldState === undefined) return;
            if (this.curWorldState === undefined) return;

            // Recall: "each player sees itself in the present but sees the
            // other entities in the past"
            // (http://www.gabrielgambetta.com/fpm3.html) so figure out how
            // far beyond the most recent server state we are right now, then
            // interpolate everyone else that amount of time between prev and
            // cur server states (i.e. one update behind).
            const now = Date.now();
            const delta = now - this.curWorldState.processedTs;
            const statesDelta = this.curWorldState.processedTs - this.prevWorldState.processedTs;
            let interpFactor = delta / statesDelta;
            if (interpFactor === Infinity) interpFactor = 1; // If it'll let us div 0, why not

            const prev = Util.cast(this.prevWorldState.value, WorldState);
            const cur = Util.cast(this.curWorldState.value, WorldState);

            for (let i = 0; i < cur.entities.length; ++i) {
                const curEntity = cur.entities[i];
                if (curEntity.id === this.entityId) continue; // don't interpolate self
                const prevEntity = prev.entities[i]; // assumes the set of entities never changes
                const newEntity = curEntity.copy();
                newEntity.x = prevEntity.x + (interpFactor * (curEntity.x - prevEntity.x));
                newEntity.speed = prevEntity.speed + (interpFactor * (curEntity.speed - prevEntity.speed));
                this.entities[i] = newEntity;
            }
        }

        render(): void {
            Util.render(this.canvas, this.entities, this.entities.length);
        }

        update(): void {
            this.processServerMessages();
            if (!this.entity) return; // not connected yet
            if (this.useEntityInterpolation) {
                this.interpolateEntities();
            }
            this.processInputs();
            this.render();
            this.nonAckdInputsElement.textContent = this.pendingInputs.length.toString();
        }

        start(): void {
            this.updateTimer = setInterval(() => this.update(), 1000 / this.tickRate);
        }

    }

    class Server {
        canvas: HTMLCanvasElement;
        clients: Array<Client> = [];           // nth client also has entityId == n
        entities: Array<Entity> = [];          // nth entry has entityId n
        lastProcessedInputSeqNums: Array<number>= []; // last processed input's seq num, by entityId
        network: LagNetwork = new LagNetwork;  // server's network (where it receives inputs from clients)
        private tickRate: number = 5;
        private updateTimer?: number;
        private worldStateSeq: number = 0;

        constructor(canvas: HTMLCanvasElement) {
            this.canvas = canvas;
        }

        connect(client: Client): void {
            client.server = this;
            const entityId = this.clients.length;
            client.entityId = entityId; // give the client its entity id so it can identify future state messages
            this.clients.push(client);

            const entity = new Entity(entityId, client.color);
            entity.x = 5; // spawn point
            this.entities.push(entity);
        }

        /** Look for cheaters here. */
        private static validInput(input: Input): boolean {
            // Not exactly sure where 1/40 comes from.  I got it from the
            // original code.  The longest possible valid "press" should be
            // 1/client.tickRate (1/60).  But the JS timers are not reliable,
            // so if you use 1/60 below you end up throwing out a lot of
            // inputs that are slighly too long... so maybe that's where 1/40
            // comes from?
            return Math.abs(input.pressTime) <= 1 / 40;
        }

        /**
         * Process all pending messages from clients.
         */
        processInputs(): void {
            while (true) {
                const msg = this.network.receive();
                if (!msg) break;
                const input = Util.cast(msg.payload, Input);
                if (!input) break;
                if (Server.validInput(input)) {
                    const id = input.entityId;
                    this.entities[id].applyInput(input);
                    this.lastProcessedInputSeqNums[id] = input.seqNum;
                } else {
                    console.log('throwing out input!', input);
                }
            }
        }

        /** Send world state to every client. */
        sendWorldState(): void {
            // Make sure to send copies of our state, and not just references.
            // i.e. simulate serializing the data like we'd do if we were
            // using a real network.
            const msg = new WorldState(
                this.worldStateSeq++,
                this.entities.map(e => e.copy()),
                this.lastProcessedInputSeqNums.slice()
            );
            this.clients.forEach(client => {
                client.network.send(client.lagMs, msg);
            });
        }

        render(): void {
            Util.render(this.canvas, this.entities, this.entities.length);
        }

        update(): void {
            this.processInputs();
            this.sendWorldState();
            this.render();
        }

        setTickRate(x: number): void {
            this.tickRate = x;
            if (this.updateTimer !== undefined) {
                clearInterval(this.updateTimer);
            }
            this.startUpdateTimer();
        }

        private startUpdateTimer(): void {
            this.updateTimer = setInterval(() => this.update(), 1000 / this.tickRate);
        }
        
        start(): void {
            this.setTickRate(this.tickRate);
        }

    }

    class Util {
        /**
         * Cast 'instance' to the type of 'ctor'.  Die if it fails.Also useful
         * for blowing up early if instance is null.
         *
         * What's is 'ctor'? A type constructor. Roughly, the thing you call
         * 'new' on. e.g. It's the function Foo below:
         *
         * <code><pre>
         * Class Foo {};
         * let f = new Foo(); //
         * </code></pre>
         *
         * https://github.com/Microsoft/TypeScript/issues/3193
         * https://github.com/Microsoft/TypeScript/blob/master/doc/spec.md#389-constructor-type-literals
         * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/instanceof
         */
        static cast<T>(instance: any, ctor: {new(...args: any[]): T}): T {
            if (instance instanceof ctor) return instance;
            throw new Error(`failed to cast '${instance}' to '${ctor}'`);
        }

        /** Render each entity on the given canvas. */
        static render(canvas: HTMLCanvasElement, entities: Array<Entity>, numPlayers: number): void {
            canvas.width = canvas.width; // hack to clear canvas
            const paddingFraction = 0.1; // amount of canvas height to leave for padding
            const yOffset = canvas.height * paddingFraction / 2;
            const radius = (canvas.height * (1 - paddingFraction)) / numPlayers / 2;
            const ctx = Util.cast(canvas.getContext("2d"), CanvasRenderingContext2D);
            entities.forEach((entity, idx) => {
                const x = entity.x * canvas.height;
                const y = radius * (2 * idx + 1);
                ctx.beginPath();
                ctx.arc(x, y + yOffset, radius, 0, 2*Math.PI, false);
                ctx.fillStyle = entity.color;
                ctx.fill();
                ctx.lineWidth = 3;
                ctx.strokeStyle = '#003300';
                ctx.stroke();
            });

        }
    }

    // This is all static, so maybe there is a better way than a class to
    // encapsulate this in TypeScript?  I don't yet fully get modules and
    // namespaces.
    class Demo {

        /**
         * Create a client instance with the given params, wire up its input
         * handling, and return it.
         */
        private static client(cssId: string, color: string, leftKeyCode: number, rightKeyCode: number): Client {
            const canvas = Util.cast(document.querySelector(`#${cssId} canvas`), HTMLCanvasElement);
            const status = Util.cast(document.querySelector(`#${cssId} .status .non-ackd`), Element);
            const c = new Client(cssId, color, canvas, status);
            // install keyboard handlers
            const keyHandler: EventListener = e => {
                const e0: Event = e || window.event;
                if (e0 instanceof KeyboardEvent) {
                    if (e0.keyCode === leftKeyCode) {
                        c.leftKeyDown = (e0.type === "keydown");
                    } else if (e0.keyCode === rightKeyCode) {
                        c.rightKeyDown = (e0.type === "keydown");
                    }
                }
            };
            document.body.addEventListener("keydown", keyHandler);
            document.body.addEventListener("keyup", keyHandler);
            return c;
        }

        /**
         * Update the simulation parameters from the current values in the
         * form elements.
         */
        private static updateParameters(server: Server, clients: Array<Client>): void {
            // update server params
            const serverTickRate = Util.cast(document.querySelector("#server .tickRate"), HTMLInputElement);
            server.setTickRate(parseFloat(serverTickRate.value));

            // update params for each client
            for (let i = 1; i <= clients.length; ++i) {
                const cssId = 'p' + i;
                const client = clients.filter(c => c.cssId === cssId)[0]; // linear; assumes small num of clients
                const getInput = (className: string): HTMLInputElement => {
                    return Util.cast(document.querySelector(`#${cssId} ${className}`), HTMLInputElement);
                };
                client.lagMs = parseInt(getInput('.lag').value);
                client.usePrediction = getInput('.prediction').checked;
                client.useReconciliation = getInput('.reconciliation').checked;
                client.useEntityInterpolation = getInput('.entity-interpolation').checked;
            }
        }

        static main(): void {
            console.log("Starting demo");
            const server = new Server(Util.cast(document.getElementById('serverCanvas'), HTMLCanvasElement));
            const clients = [
                Demo.client('p1', 'red', 81, 69),   // q, e
                Demo.client('p2', 'green', 65, 68), // a, d
                Demo.client('p3', 'blue', 90, 67)   // z, c
            ];

            // Connect each client to the server and start their update timers
            clients.forEach(client => {
                console.log(`Connecting client ${client.cssId}`);
                server.connect(client);
                client.start();
            });

            Demo.updateParameters(server, clients);
            server.start();

            // Hook up listeners to update simulation when text boxes change
            const inputs = document.querySelectorAll("input");
            for (let i = 0; i < inputs.length; ++i) {
                let input = Util.cast(inputs.item(i), HTMLInputElement);
                input.addEventListener("change", () => {
                   Demo.updateParameters(server, clients);
                });
            }
        }
    }

    Demo.main();
}
