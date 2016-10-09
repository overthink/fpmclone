// A note on this code: I'm teaching myself TypeScript, "modern" JS dev, and
// basic game programming as I go, so the level of commenting in here is a bit
// overkill.  Hopefully it's still somewhat readable.

namespace FMPDemo {

    /** Something sent over the "wire".  Just a marker for now. */
    interface Message {}

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
    }

    class WorldState implements Message {
        entities: Array<Entity>;

        /** Last input the server has processed from the client to which the
         * WorldState message is sent. */
        lastProcessedInputSeqNums: Array<number>;

        constructor(entities: Array<Entity>, lastProcessedInputSeqNums: Array<number>) {
            this.entities = entities;
            this.lastProcessedInputSeqNums = lastProcessedInputSeqNums;
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
        receive(): Message | undefined {
            let now = Date.now();
            for (let i = 0; i < this.messages.length; ++i) {
                var qm = this.messages[i];
                if (qm.recvTs <= now) {
                    this.messages.splice(i, 1);
                    return qm.payload;
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

        // The player's entity in the world; server provides it.
        entity?: Entity;
        entities: Array<Entity> = []; // awful, contains reference to this.entity as well

        leftKeyDown: boolean = false;
        rightKeyDown: boolean = false;
        network: LagNetwork = new LagNetwork;
        lastUpdateTs: number = -1;
        inputSeqNum: number = 0;
        pendingInputs: Array<Input> = [];

        usePrediction: boolean = false;
        useReconciliation: boolean = false;
        lagMs: number = 250;
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

                const worldState = Util.cast(msg, WorldState);
                worldState.entities.forEach(entity => {
                    if (this.entityId === undefined) return; // making tsc happy...

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

                            // First, keep inputs that have not yet been taken
                            // into account by the last WorldState sent by the
                            // server.
                            const lastProcessed = worldState.lastProcessedInputSeqNums[this.entityId];
                            this.pendingInputs = this.pendingInputs.filter(input => {
                                return input.seqNum > lastProcessed;
                            });

                            // apply any remaining inputs to our local world state
                            this.pendingInputs.forEach(input => {
                                if (this.entity) {
                                    this.entity.applyInput(input);
                                }
                            });
                        }

                    } else {
                        // non-local-player entity

                        // what I should be doing is creating a local entity
                        // for every remote entity I haven't seen before, then
                        // update all my local entities, and finally drop any
                        // local entities that aren't mentioned in the server
                        // message.

                        // this sucks with the current data structures...
                        // would like to just wholesale replace all local
                        // state with what the server sent

                        this.entities[entity.id] = entity;
                    }
                });
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
                this.entity.applyInput(input);
            }

            // save input for later reconciliation
            if (this.useReconciliation) {
                this.pendingInputs.push(input);
            }
        }

        render(): void {
            Util.render(this.canvas, this.entities, this.entities.length);
        }

        update(): void {
            this.processServerMessages();
            if (!this.entity) return; // not connected yet
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
        private static validateInput(input: Input): boolean {
            return Math.abs(input.pressTime) <= 1 / 40;
        }

        /**
         * Process all pending messages from clients.
         */
        processInputs(): void {
            while (true) {
                const msg = this.network.receive();
                if (msg === undefined) break;
                const input = Util.cast(msg, Input);
                if (!input) break;
                if (Server.validateInput(input)) {
                    const id = input.entityId;
                    this.entities[id].applyInput(input);
                    this.lastProcessedInputSeqNums[id] = input.seqNum;
                }
            }
        }

        /** Send world state to every client. */
        sendWorldState(): void {
            this.clients.forEach(client => {
                // Yes, I'm "sending" references to the Server's objects...
                // Skipping serialization for this example program.
                const msg = new WorldState(this.entities, this.lastProcessedInputSeqNums);
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
            if (this.updateTimer) {
                clearInterval(this.updateTimer);
            }
            this.startUpdateTimer();
        }

        private startUpdateTimer(): void {
            this.updateTimer = setInterval(() => this.update(), 1000 / this.tickRate);
        }
        
        start(): void {
             this.startUpdateTimer();
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
                    // console.log(cssId, c.cssId, e0.keyCode);
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
            server.setTickRate(parseInt(serverTickRate.value));

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
