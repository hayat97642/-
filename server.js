(async () => {
    const { Worker } = await import("worker_threads");
    const { WebSocketServer } = await import("ws");
    const { pack, unpack } = await import("msgpackr");
    const http = await import("http");
    const fetch = globalThis.fetch ?? (await import("node-fetch")).default;
    const { normalizeMainTickMs, getSpawnDelayMs } = await import("./resource-utils.js");

    const prod = false;
    
    const PROXIES = ["http://IPv4D_ZSM7Iqg2Y0-ttl-0:CaXclKLgv4aUhfH@datacenter-ww.lightningproxies.net:1338"];
    const MAX_BOTS = 256;
    const SHARED_STATE_SIZE = 16 + MAX_BOTS * 2;

    console.log("Master: Loading local WASM and Game Script...");

    const fs = require("fs");
    const path = require("path");

    // Load local app.wasm (no internet needed for startup)
    const wasmPath = path.join(__dirname, "app.wasm");
    console.log("Master: Loading WASM from", wasmPath);
    const wasmBuffer = fs.readFileSync(wasmPath);

    // Load local index.html and extract the game script
    const htmlPath = path.join(__dirname, "index.html");
    console.log("Master: Loading game script from", htmlPath);
    const html = fs.readFileSync(htmlPath, "utf8");
    
    // Extract script from HTML
    const scriptTagStart = html.indexOf('<script>');
    const scriptStart = scriptTagStart + 8;
    const scriptTagEnd = html.indexOf('</script>', scriptStart);
    const gameScript = html.slice(scriptStart, scriptTagEnd);

    const sharedWasm = await WebAssembly.compile(wasmBuffer);
    console.log("Master: WASM fully compiled and ready to share.");

    // HTTP SERVER
    const server = http.createServer((req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("rexxy on top");
    });

    // WS SERVER
    function randint(a, b) {
        return Math.floor(Math.random() * (b - a + 1)) + a;
    }

    const sessions = new Map();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws, req) => {
        const addr = req.socket.remoteAddress;
        console.log(addr, "connected");

        // Initialize or retrieve session for this IP
        if (!sessions.has(addr)) {
            const sharedState = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * SHARED_STATE_SIZE);
            const sharedStateArray = new Float32Array(sharedState);
            // Initialize default common state values
            sharedStateArray[11] = 0;
            sharedStateArray[15] = 0;
            sessions.set(addr, {
                workers: [],
                tank: "auto6",
                tanks: [],
                tankIdx: 0,
                proxyIdx: 0,
                sharedState,
                sharedStateArray
            });
        }
        const session = sessions.get(addr);

        let challenge;
        let verified = false;

        function packet(...args) {
            ws.send(pack(args));
        }

        function close() {
            ws.close();
        }

        ws.on("message", (msg) => {
            try {
                const data = unpack(msg);
                const type = data.shift();

                switch (type) {
                    case "M":
                        if (challenge || data[0] != 72011) {
                            close();
                        }
                        challenge = randint(0b1000000000, 0b1111111111);
                        packet("M", challenge);
                        break;

                    case "C":
                        if (data[0] == (challenge ^ 845)) {
                            verified = true;
                            console.log(addr, "verified");
                        } else {
                            close();
                            console.log(addr, "true noob")
                        }
                        break;

                    case "Z":
                        session.tank = data[0];
                        if (session.tank instanceof Array) {
                            session.tanks = session.tank;
                            session.tankIdx = 0;

                            for (const worker of session.workers) {
                                let t = session.tanks[session.tankIdx];
                                worker.postMessage({ type: "tankselect", tank: t });

                                session.tankIdx++;
                                if (session.tankIdx >= session.tanks.length) {
                                    session.tankIdx = 0;
                                }
                            }
                        } else {
                            session.tanks = [];
                            for (const worker of session.workers) {
                                // CHANGED: .send() -> .postMessage()
                                worker.postMessage({ type: "tankselect", tank: session.tank })
                            }
                        }
                        break;

                    case "F":
                        if (verified) {
                            const hash = data[0];
                            const count = parseInt(data[1]) || 1;
                            const customName = data[2] || "";
                            const spawnDelay = parseInt(data[3]) || 0;
                            const mainTickMs = normalizeMainTickMs(parseInt(data[4]) || 140);
                            const autoRespawn = data.length > 5 ? !!data[5] : true;

                            console.log(`Starting spawn sequence for ${count} bots named "${customName}" (Hash: ${hash}, delay: ${spawnDelay}ms, tick: ${mainTickMs}ms, autoRespawn: ${autoRespawn})`);

                            (async () => {
                                for (let i = 0; i < count; i++) {
                                    if (session.proxyIdx >= PROXIES.length) {
                                        session.proxyIdx = 0;
                                    }

                                    const worker = new Worker("./index.js", {
                                        workerData: { sharedState: session.sharedState }
                                    });
                                    session.workers.push(worker);
                                    if (worker.unref) {
                                        worker.unref();
                                    }

                                    worker.on("error", (err) => {
                                        console.error(`Worker ${i} error:`, err);
                                    });
                                    worker.on("exit", (code) => {
                                        if (code !== 0) {
                                            console.error(`Worker ${i} exited with code ${code}`);
                                        } else {
                                            console.log(`Worker ${i} exited cleanly.`);
                                        }
                                    });

                                    const selectedTank = session.tanks.length
                                        ? session.tanks[session.tankIdx]
                                        : session.tank;

                                    if (session.tanks.length) {
                                        worker.postMessage({ type: "tankselect", tank: selectedTank });
                                        session.tankIdx++;
                                        if (session.tankIdx >= session.tanks.length) {
                                            session.tankIdx = 0;
                                        }
                                    } else {
                                        worker.postMessage({ type: "tankselect", tank: selectedTank });
                                    }

                                    worker.postMessage({
                                        type: "start",
                                        sharedWasm: sharedWasm,
                                        gameScript: gameScript,
                                        config: {
                                            id: i,
                                            proxy: {
                                                type: "http",
                                                url: PROXIES[session.proxyIdx]
                                            },
                                            hash: "#" + hash,
                                            name: customName,
                                            stats: [0, 0, 0, 0, 0, 0, 0, 9],
                                            type: "follow",
                                            token: "follow-8fe6ca",
                                            autoFire: false,
                                            autoRespawn: autoRespawn,
                                            keys: [],
                                            keysHold: [],
                                            tank: selectedTank,
                                            chatSpam: "",
                                            mainTickMs: mainTickMs,
                                            squadId: hash,
                                            reconnectAttempts: 3,
                                            reconnectDelay: 15000,
                                        }
                                    });

                                    session.proxyIdx++;
                                    if ((i + 1) % 10 === 0 || i + 1 === count) {
                                        console.log(`Spawned bot ${i + 1}/${count}`);
                                    }

                                    if (i + 1 < count) {
                                        const safeSpawnDelay = getSpawnDelayMs(spawnDelay);
                                        await new Promise(resolve => setTimeout(resolve, safeSpawnDelay));
                                    }
                                }
                                console.log("All bots successfully spawned!");
                            })();
                        }
                        break;

                    case "B":
                        if (verified) {
                            for (const worker of session.workers) {
                                worker.postMessage({ type: "destroy" });
                            }
                            session.workers = [];
                        }
                        break;

                    case "A":
                        if (verified) {
                            const surroundCoords = Array.isArray(data[15]) ? data[15] : null;
                            const s = session.sharedStateArray;
                            if (s) {
                                const rawX = data[0];
                                const rawY = data[1];
                                const hasCoords = rawX !== null && rawX !== undefined && rawY !== null && rawY !== undefined
                                    && Number.isFinite(Number(rawX)) && Number.isFinite(Number(rawY));
                                const overrideEnabled = data[14] ? 1 : 0;
                                s[0] = hasCoords ? Number(rawX) : NaN;
                                s[1] = hasCoords ? Number(rawY) : NaN;
                                s[2] = data[2] || 0;
                                s[3] = data[3] || 0;
                                s[4] = data[4] ? 1 : 0;
                                s[5] = data[5] ? 1 : 0;
                                s[6] = data[6] ? 1 : 0;
                                s[7] = data[7] ? 1 : 0;
                                s[8] = data[8] ? 1 : 0;
                                s[9] = data[9] ? 1 : 0;
                                s[10] = data[10] ? 1 : 0;
                                s[11] = data[11] ? 1 : 0;
                                s[12] = data[12] || 0;
                                s[13] = data[13] || 0;
                                s[14] = parseFloat(overrideEnabled) || 1;
                                s[15] = overrideEnabled;

                                const pairsCount = Math.min(session.workers.length, MAX_BOTS);
                                if (surroundCoords) {
                                    for (let i = 0; i < pairsCount; i++) {
                                        s[16 + i * 2] = surroundCoords.length >= (i * 2 + 2)
                                            ? surroundCoords[i * 2]
                                            : data[12];
                                        s[16 + i * 2 + 1] = surroundCoords.length >= (i * 2 + 2)
                                            ? surroundCoords[i * 2 + 1]
                                            : data[13];
                                    }
                                } else {
                                    for (let i = 0; i < pairsCount; i++) {
                                        s[16 + i * 2] = NaN;
                                        s[16 + i * 2 + 1] = NaN;
                                    }
                                }
                            }
                        }
                        break;

                    case "T":
                        if (verified) {
                            for (const worker of session.workers) {
                                worker.postMessage({
                                    type: "chat",
                                    message: data[0],
                                    spam: data[1]
                                });
                            }
                        }
                        break;

                    default:
                        close();
                        break;
                }
            } catch (e) {
                console.error(e);
            }
        });

        ws.on("close", () => {
            console.log(addr, "disconnected (session retained)");
        });
    });

    const port = prod ? process.env.PORT : 8082;
    server.listen(port, () => {
        console.log("Server listening on port", port);
    });
})();
