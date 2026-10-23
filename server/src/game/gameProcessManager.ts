import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type MapDefKey, MapDefs } from "../../../shared/defs/mapDefs.ts";
import { pickSpecOpsMapName, specOpsMapMatches } from "../../../shared/defs/maps/specOpsDefs.ts";
import { parseSpecOpsDifficulty } from "../../../shared/defs/maps/specOpsShop.ts";
import type { TeamMode } from "../../../shared/gameConfig.ts";
import { util } from "../../../shared/utils/util.ts";
import { Config, maxPlayersForMap, teamSizeForMode } from "../config.ts";
import { validateSquadName } from "../utils/badWords.ts";
import { ServerLogger } from "../utils/logger.ts";
import { type FindGamePrivateBody, type ServerGameConfig } from "../utils/types.ts";
import { type GameData, type JoinTokensAppliedMsg, type ProcessMsg, ProcessMsgType } from "./ipcTypes.ts";

let procFile: string;

if (import.meta.filename.endsWith(".ts")) {
    procFile = path.join(import.meta.dirname, "gameProcess.ts");
} else {
    procFile = path.join(import.meta.dirname, "gameProcess.js");
}

export enum ProcState {
    Idle,
    CreatingGame,
    Running,
}

function isProcRunning(proc: { state: ProcState }): boolean {
    return proc.state === ProcState.Running;
}

class GameProcess {
    process: ChildProcess;
    port: number;

    gameData: GameData = {
        id: "",
        teamMode: 0 as TeamMode,
        squadSize: Config.maxSquadSize,
        mapName: "",
        canJoin: false,
        browsable: false,
        aliveCount: 0,
        pendingJoinTokens: 0,
        startedTime: 0,
        stopped: false,
        timeRunning: 0,
        difficulty: "regular",
        endless: false,
    };

    state = ProcState.Idle;

    createdTime = Date.now();

    stoppedTime = Date.now();
    lastMsgTime = Date.now();

    manager: GameProcessManager;

    onCreatedCbs: Array<(_proc: typeof this) => void> = [];

    private joinTokenWaiters: Array<{
        minAccepted: number;
        resolve: (ok: boolean) => void;
    }> = [];

    avaliableSlots = 0;

    reusedCount = 0;
    noFill = false;

    constructor(
        manager: GameProcessManager,
        id: string,
        config: ServerGameConfig,
        port: number,
    ) {
        this.manager = manager;
        this.port = port;

        this.process = fork(procFile, [port.toString()], {
            serialization: "advanced",
            execArgv: ["--expose-gc"],
            execPath: process.execPath,
        });

        this.process.on("message", (msg: ProcessMsg) => {
            this._onProcessMsg(msg);
        });

        this.create(id, config);
    }

    private _onProcessMsg(msg: ProcessMsg) {
        if (msg.type) {
            this.lastMsgTime = Date.now();
        }

        switch (msg.type) {
            case ProcessMsgType.UpdateData: {
                // Reused processes can still emit UpdateData from the previous match
                // after create() assigned a new id. Applying those messages resets
                // CreatingGame → Idle and leaves findGame waiting forever.
                if (msg.id !== this.gameData.id) {
                    break;
                }

                if (this.state === ProcState.CreatingGame && !msg.stopped) {
                    this.state = ProcState.Running;
                    for (const cb of this.onCreatedCbs) {
                        cb(this);
                    }
                    this.onCreatedCbs.length = 0;
                    if (this.reusedCount === 1) {
                        this.manager.logger.info(
                            `Process ${this.process.pid} created in ${Date.now() - this.createdTime}ms`,
                        );
                    }
                }

                this.gameData = msg;
                const mapDef = MapDefs[this.gameData.mapName as MapDefKey];
                if (mapDef?.gameMode.specOpsMode) {
                    const cap = teamSizeForMode(
                        this.gameData.teamMode,
                        this.gameData.squadSize ?? Config.maxSquadSize,
                    );
                    this.avaliableSlots = Math.max(
                        0,
                        cap - this.gameData.aliveCount - this.gameData.pendingJoinTokens,
                    );
                }
                if (!this.gameData.stopped) {
                    this.manager.schedulePublicGamesSync();
                }
                if (this.gameData.stopped) {
                    this.stoppedTime = Date.now();
                    this.state = ProcState.Idle;
                }
                break;
            }
            case ProcessMsgType.JoinTokensApplied: {
                const appliedMsg = msg as JoinTokensAppliedMsg;
                const applied = appliedMsg.accepted;
                const pending = appliedMsg.pendingJoinTokens;
                if (applied > 0) {
                    this.gameData.pendingJoinTokens = pending;
                    const mapDef = MapDefs[this.gameData.mapName as MapDefKey];
                    if (mapDef?.gameMode.specOpsMode) {
                        const cap = teamSizeForMode(
                            this.gameData.teamMode,
                            this.gameData.squadSize ?? Config.maxSquadSize,
                        );
                        this.avaliableSlots = Math.max(
                            0,
                            cap - this.gameData.aliveCount - pending,
                        );
                    }
                }
                for (let i = this.joinTokenWaiters.length - 1; i >= 0; i--) {
                    const waiter = this.joinTokenWaiters[i];
                    if (applied >= waiter.minAccepted) {
                        util.removeFrom(this.joinTokenWaiters, waiter);
                        waiter.resolve(true);
                    }
                }
                break;
            }
        }
    }

    waitForJoinTokens(minAccepted: number, timeoutMs = 2000): Promise<boolean> {
        if (minAccepted <= 0) return Promise.resolve(true);
        return new Promise((resolve) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                if (timeout !== undefined) clearTimeout(timeout);
                resolve(ok);
            };
            const waiter = { minAccepted, resolve: finish };
            this.joinTokenWaiters.push(waiter);
            timeout = setTimeout(() => {
                util.removeFrom(this.joinTokenWaiters, waiter);
                finish(false);
            }, timeoutMs);
        });
    }

    send(msg: ProcessMsg) {
        if (this.process.killed || !this.process.channel) return;
        this.process.send(msg);
    }

    create(id: string, config: ServerGameConfig) {
        // Assign the new id BEFORE notifying the child. Otherwise a fast
        // UpdateData can arrive while gameData.id is still the previous
        // match id and get dropped as "stale", leaving findGame hung.
        this.gameData = {
            ...this.gameData,
            id,
            teamMode: config.teamMode,
            squadSize: teamSizeForMode(config.teamMode, config.squadSize ?? Config.maxSquadSize),
            mapName: config.mapName,
            canJoin: false,
            browsable: false,
            aliveCount: 0,
            pendingJoinTokens: 0,
            startedTime: 0,
            stopped: false,
            timeRunning: 0,
            difficulty: config.difficulty ?? "regular",
            endless: config.endless ?? false,
        };
        this.noFill = false;
        this.state = ProcState.CreatingGame;

        this.send({
            type: ProcessMsgType.Create,
            id,
            config,
        });

        const mapDef = MapDefs[this.gameData.mapName as MapDefKey];
        this.avaliableSlots = maxPlayersForMap(
            !!mapDef.gameMode.specOpsMode,
            mapDef.gameMode.maxPlayers,
            teamSizeForMode(config.teamMode, config.squadSize ?? Config.maxSquadSize),
            Config.maxPlayersPerGame,
        );

        this.reusedCount++;
    }

    addJoinTokens(
        tokens: FindGamePrivateBody["playerData"],
        autoFill: boolean,
        squadName = "",
    ) {
        if (!autoFill) {
            this.noFill = true;
            this.gameData.canJoin = false;
            this.gameData.browsable = false;
        }
        this.send({
            type: ProcessMsgType.AddJoinToken,
            autoFill,
            tokens,
            squadName,
        });
        this.manager.schedulePublicGamesSync();
    }
}

export type PublicGamesSyncHandler = () => void;

export class GameProcessManager {
    readonly processById = new Map<string, GameProcess>();
    readonly processes: GameProcess[] = [];

    readonly logger = new ServerLogger("Game Process Manager");

    onPublicGamesSync?: PublicGamesSyncHandler;
    private _publicGamesSyncTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly _freePorts: number[] = [];

    schedulePublicGamesSync() {
        if (this._publicGamesSyncTimer) return;
        this._publicGamesSyncTimer = setTimeout(() => {
            this._publicGamesSyncTimer = undefined;
            this.onPublicGamesSync?.();
        }, 250);
        this._publicGamesSyncTimer.unref?.();
    }

    getNextPort() {
        return this._freePorts.shift();
    }

    constructor() {
        for (let i = 0; i < Config.gameServer.maxGames; i++) {
            this._freePorts.push(Config.gameServer.firstGamePort + i);
        }

        // always keep some processes running even if theres no active games on them
        // creating a new proc is more expensive than reusing one
        const minIdleProcs = 3;

        setInterval(() => {
            for (const proc of this.processes) {
                proc.send({
                    type: ProcessMsgType.KeepAlive,
                });

                // kill processes that didn't send a keep alive msg in 10 seconds
                // because this usually means they are frozen in an infinite loop
                if (Date.now() - proc.lastMsgTime > 10000) {
                    const id = proc.gameData.id.substring(0, 4);
                    this.logger.warn(
                        `Process ${proc.process.pid} - #${id} did not send a message in more 10 seconds, killing`,
                    );
                    // sigquit can dump a core of the process
                    // useful for debugging infinite loops
                    this.killProcess(proc, "SIGQUIT");
                    continue;
                }
            }

            const idleProcs = this.processes.filter(p => {
                return p.gameData.stopped && (Date.now() - p.stoppedTime) > 60000;
            });

            // kill stale processes if there's too many
            if (idleProcs.length > minIdleProcs) {
                idleProcs.sort((a, b) => a.createdTime - b.createdTime);

                const procsToKill = Math.abs(minIdleProcs - idleProcs.length);
                for (let i = 0; i < procsToKill; i++) {
                    const proc = idleProcs[i];
                    this.logger.info(`Killing ${proc.process.pid} because we have too many stale processes`);
                    this.killProcess(proc);
                }
            }
        }, 5000);
    }

    getPlayerCount(): number {
        return this.processes.reduce((a, b) => {
            return a + b.gameData.aliveCount;
        }, 0);
    }

    newGame(config: ServerGameConfig): GameProcess | undefined {
        config = {
            ...config,
            mapName: pickSpecOpsMapName(config.mapName) as MapDefKey,
            difficulty: config.difficulty ?? Config.difficulty,
            endless: config.endless ?? Config.endless ?? false,
            contractsEnabled: config.contractsEnabled ?? Config.contractsEnabled,
        };
        let gameProc: GameProcess | undefined;

        for (let i = 0; i < this.processes.length; i++) {
            const p = this.processes[i];
            if (p.gameData.stopped) {
                gameProc = p;
                break;
            }
        }

        const id = randomUUID();
        if (!gameProc) {
            const port = this.getNextPort();
            if (port === undefined) {
                return undefined;
            }
            gameProc = new GameProcess(this, id, config, port);

            this.processes.push(gameProc);

            gameProc.process.on("exit", () => {
                this.killProcess(gameProc!);
                if (!this._freePorts.includes(gameProc!.port)) {
                    this._freePorts.push(gameProc!.port);
                }
            });

            gameProc.process.on("close", () => {
                this.killProcess(gameProc!);
            });
            gameProc.process.on("disconnect", () => {
                this.killProcess(gameProc!);
            });
            this.logger.info("Created new process with PID", gameProc.process.pid);
        } else {
            this.processById.delete(gameProc.gameData.id);
            gameProc.create(id, config);
        }

        this.processById.set(id, gameProc);

        return gameProc;
    }

    killProcess(gameProc: GameProcess, signal: NodeJS.Signals = "SIGTERM"): void {
        // send SIGTERM, if still hasn't terminated after 5 seconds, send SIGKILL >:3
        gameProc.process.kill(signal);
        setTimeout(() => {
            if (!gameProc.process.killed) {
                gameProc.process.kill("SIGKILL");
            }
        }, 5000);

        util.removeFrom(this.processes, gameProc);
        this.processById.delete(gameProc.gameData.id);
    }

    /** Kill forked game children (e.g. on dev server reload). */
    shutdownAll(signal: NodeJS.Signals = "SIGTERM"): void {
        for (const proc of [...this.processes]) {
            this.killProcess(proc, signal);
        }
    }

    getById(id: string): GameProcess | undefined {
        return this.processById.get(id);
    }

    async findGame(body: FindGamePrivateBody): Promise<GameProcess | undefined> {
        const partySize = Math.max(1, body.playerData.length);
        const specOps = !!MapDefs[body.mapName as MapDefKey]?.gameMode.specOpsMode;
        const difficulty = parseSpecOpsDifficulty(body.difficulty ?? Config.difficulty);
        const endless = body.endless ?? Config.endless ?? false;
        const requestedTeamSize = teamSizeForMode(
            body.teamMode,
            body.squadSize ?? Config.maxSquadSize,
        );

        // avaliableSlots tracks reserved seats (connected + pending join tokens).
        const seatsLeft = (proc: GameProcess) => proc.avaliableSlots;

        let proc: GameProcess | undefined;
        const rejoinTarget = !!body.gameId;

        if (body.gameId) {
            proc = this.getById(body.gameId);
            if (
                !proc
                || proc.gameData.stopped
                || proc.state === ProcState.Idle
                || proc.state !== ProcState.Running
            ) {
                // Stale team lobby gameId — fall through only when not an explicit rejoin.
                proc = undefined;
            }
        }

        if (!proc && rejoinTarget) {
            return undefined;
        }

        if (!proc && !(specOps && !body.autoFill)) {
            proc = this.processes
                .filter((proc) => {
                    const game = proc.gameData;
                    const joinable = (proc.state === ProcState.Running
                        ? game.canJoin
                        : proc.state === ProcState.CreatingGame)
                        && !proc.noFill;
                    const sameSettings = !specOps
                        || (
                            parseSpecOpsDifficulty(game.difficulty) === difficulty
                            && !!game.endless === endless
                        );
                    return (
                        joinable
                        && seatsLeft(proc) >= partySize
                        && game.teamMode === body.teamMode
                        && teamSizeForMode(
                            game.teamMode,
                            game.squadSize ?? Config.maxSquadSize,
                        ) === requestedTeamSize
                        && (specOps
                            ? specOpsMapMatches(body.mapName, game.mapName)
                            : game.mapName === body.mapName)
                        && sameSettings
                        // Started Spec Ops with no connected humans must not matchmake.
                        && !(specOps && game.startedTime > 1 && game.aliveCount <= 0)
                    );
                })
                .sort((a, b) => {
                    return a.gameData.startedTime - b.gameData.startedTime;
                })[0];
        }

        if (!proc) {
            proc = this.newGame({
                teamMode: body.teamMode,
                squadSize: body.squadSize,
                mapName: body.mapName as MapDefKey,
                difficulty,
                endless,
                contractsEnabled: body.contractsEnabled ?? Config.contractsEnabled,
            });
            if (proc && specOps && !body.autoFill) {
                proc.noFill = true;
            }
        }

        if (!proc) {
            return undefined;
        }

        // if the game has not finished creating
        // wait for it to be created to send the find game response
        if (proc.state !== ProcState.Running) {
            const waiting = proc;
            const ready = await new Promise<boolean>((resolve) => {
                if (isProcRunning(waiting)) {
                    resolve(true);
                    return;
                }

                const timeout = setTimeout(() => {
                    util.removeFrom(waiting.onCreatedCbs, onReady);
                    if (waiting.state === ProcState.CreatingGame) {
                        waiting.state = ProcState.Idle;
                        waiting.gameData.canJoin = false;
                        waiting.gameData.browsable = false;
                        waiting.gameData.stopped = true;
                    }
                    this.logger.warn(
                        `Timed out waiting for game process ${waiting.process.pid} to become ready`,
                    );
                    resolve(false);
                }, 15000);

                const onReady = () => {
                    clearTimeout(timeout);
                    resolve(true);
                };
                waiting.onCreatedCbs.push(onReady);

                // UpdateData may have flipped CreatingGame → Running between the
                // check above and registering the callback — avoid hanging.
                if (isProcRunning(waiting)) {
                    clearTimeout(timeout);
                    util.removeFrom(waiting.onCreatedCbs, onReady);
                    resolve(true);
                }
            });

            if (!ready || !isProcRunning(proc)) {
                return undefined;
            }
        }

        if (!rejoinTarget && seatsLeft(proc) < partySize) {
            return undefined;
        }

        //A join that targets an exisitng match 
        //must not change that match's fill setting. No fill only applies
        //when a party creates a new match; 
        //lobbies started with Fill off are already locked at creation time
        const autoFill = rejoinTarget ? true : body.autoFill;

        proc.addJoinTokens(
            body.playerData,
            autoFill,
            validateSquadName(body.squadName),
        );
        const tokensApplied = await proc.waitForJoinTokens(body.playerData.length);
        if (!tokensApplied) {
            return undefined;
        }

        return proc;
    }
}
