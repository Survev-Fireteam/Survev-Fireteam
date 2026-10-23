import $ from "jquery";
import * as PIXI from "pixi.js-legacy";
import type { PublicGameInfo } from "../../shared/types/api.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { parseSpecOpsDifficulty } from "../../shared/defs/maps/specOpsShop.ts";
import * as net from "../../shared/net/net.ts";
import type {
    FindGameBody,
    FindGameError,
    FindGameMatchData,
    FindGameResponse,
    GameWsDisconnectReason,
} from "../../shared/types/api.ts";
import { math } from "../../shared/utils/math.ts";
import { normalizeTeamRoomKey } from "../../shared/types/team.ts";
import { Account } from "./account.ts";
import { Ambiance } from "./ambiance.ts";
import { api } from "./api.ts";
import { AudioManager } from "./audioManager.ts";
import { ConfigManager, type ConfigType } from "./config.ts";
import { device } from "./device.ts";
import { errorLogManager } from "./errorLogs.ts";
import { Game } from "./game.ts";
import {
    advancedDefaultsForQuality,
    clampRenderScale,
    COMMUNITY_ANNOUNCEMENT_SNOOZE_MS,
    COMMUNITY_ANNOUNCEMENT_VERSION,
    parseGraphicsQuality,
    pixiResolution,
    resolveGraphicsProfile,
} from "./graphicsQuality.ts";
import { helpers } from "./helpers.ts";
import { InputHandler } from "./input.ts";
import { InputBinds, InputBindUi } from "./inputBinds.ts";
import {
    clearMatchSession,
    clearRejoinUrlParams,
    ensureRejoinAfterReload,
    getActiveMatchSession,
    getRejoinSession,
    getTeamLobbySession,
    markMatchDisconnected,
    mergeRejoinSessions,
    parseRejoinFromLocation,
    persistRejoinSession,
    rejoinSecondsLeft,
    resolveTeamRoomUrl,
    saveActiveMatch,
    storeRejoinToken,
    syncRejoinUrl,
    teamRoomCode,
    touchActiveMatchIdentity,
    type ActiveMatchSession,
} from "./matchRejoin.ts";
import { PingTest } from "./pingTest.ts";
import { proxy } from "./proxy.ts";
import { ResourceManager } from "./resources.ts";
import { SDK } from "./sdk/sdk.ts";
import { resolveServerId, SiteInfo } from "./siteInfo.ts";
import { LoadoutMenu } from "./ui/loadoutMenu.ts";
import { Localization } from "./ui/localization.ts";
import Menu from "./ui/menu.ts";
import { MenuModal } from "./ui/menuModal.ts";
import { LoadoutDisplay } from "./ui/opponentDisplay.ts";
import { Pass } from "./ui/pass.ts";
import { ProfileUi } from "./ui/profileUi.ts";
import { MenuLeaderboard } from "./ui/menuLeaderboard.ts";
import { ServerBrowser } from "./ui/serverBrowser.ts";
import { TeamMenu, teamHashJoin } from "./ui/teamMenu.ts";
import { loadStaticDomImages } from "./ui/ui2.ts";
import { setupMenuGamepad } from "./menuGamepadSetup.ts";
import { focusGameCanvas, requestSteamDeckFullscreen, setupSteamDeck } from "./steamDeck.ts";

export class Application {
    nameInput = $("#player-name-input-solo");
    serverSelect = $("#server-select-main");
    playMode0Btn = $("#btn-start-mode-0");
    playMode1Btn = $("#btn-start-mode-1");
    playMode2Btn = $("#btn-start-mode-2");
    deployBtn = $("#btn-specops-deploy");
    muteBtns = $(".btn-sound-toggle");
    aimLineBtn = $("#btn-game-aim-line");
    masterSliders = $<HTMLInputElement>(".sl-master-volume");
    soundSliders = $<HTMLInputElement>(".sl-sound-volume");
    musicSliders = $<HTMLInputElement>(".sl-music-volume");
    graphicsQualitySelect = $<HTMLSelectElement>("#graphicsQuality");
    renderScaleSlider = $<HTMLInputElement>("#renderScale");
    serverWarning = $("#server-warning");
    rejoinBanner = $("#match-rejoin-banner");
    rejoinPromptText = $("#match-rejoin-prompt-text");
    rejoinBtn = $("#btn-match-rejoin");
    rejoinDismissBtn = $("#btn-match-rejoin-dismiss");
    languageSelect = $<HTMLSelectElement>(".language-select");
    startMenuWrapper = $("#start-menu-wrapper");
    gameAreaWrapper = $("#game-area-wrapper");
    playButtons = $(".play-button-container");
    playLoading = $(".play-loading-outer");
    errorModal = new MenuModal($("#modal-notification"));
    refreshModal = new MenuModal($("#modal-refresh"));
    ipBanModal = new MenuModal($("#modal-ip-banned"));
    communityAnnounceModal = new MenuModal($("#modal-community-announce"));
    config = new ConfigManager();
    localization = new Localization();

    account!: Account;
    loadoutMenu!: LoadoutMenu;
    pass!: Pass;
    profileUi!: ProfileUi;

    pingTest = new PingTest();
    audioManager = new AudioManager();
    ambience = new Ambiance();

    siteInfo!: SiteInfo;
    teamMenu!: TeamMenu;
    serverBrowser!: ServerBrowser;
    menuLeaderboard!: MenuLeaderboard;

    pixi: PIXI.Application<PIXI.ICanvas> | null = null;
    resourceManager: ResourceManager | null = null;
    input: InputHandler | null = null;
    inputBinds: InputBinds | null = null;
    inputBindUi: InputBindUi | null = null;
    game: Game | null = null;
    loadoutDisplay: LoadoutDisplay | null = null;
    domContentLoaded = false;
    configLoaded = false;
    initialized = false;
    active = false;
    sessionId = helpers.random64();
    contextListener = function(e: MouseEvent) {
        e.preventDefault();
    };

    errorMessage = "";
    quickPlayPendingModeIdx = -1;
    findGameAttempts = 0;
    findGameTime = 0;
    findGameAbort: AbortController | null = null;
    pauseTime = 0;
    wasPlayingVideo = false;
    checkedPingTest = false;
    hasFocus = true;
    newsDisplayed = true;
    selectedGameModeIdx = 0;
    private rejoinTicker: ReturnType<typeof setInterval> | null = null;
    private rejoinPending = false;
    private rejoinWatchdog: ReturnType<typeof setTimeout> | null = null;
    private fetchRejoinTokenPromise: Promise<boolean> | null = null;
    private activeMatchMeta: {
        region: string;
        gameModeIdx: number;
        teamRoomUrl?: string;
    } | null = null;

    updateLogoBasedOnLanguage(lang: string) {
        const header = $("#start-row-header");
        if (!header.length) return;
        header.toggleClass("lang-ru", lang === "ru");
    }

    constructor() {
        errorLogManager.installConsoleCapture(this.sessionId);
        this.account = new Account(this.config);
        this.loadoutMenu = new LoadoutMenu(this.account, this.localization);
        this.pass = new Pass(this.account, this.loadoutMenu, this.localization);
        this.profileUi = new ProfileUi(
            this.account,
            this.localization,
            this.loadoutMenu,
            this.errorModal,
        );
        this.siteInfo = new SiteInfo(this.config, this.localization);
        this.siteInfo.onLoaded = (info) => {
            this.game?.editor?.setDebugAllowed(!!info.allowEditMsg);
            this.game?.editor?.setSpecOpsNpcSpawn(!!info.specOpsNpcSpawn);
            this.teamMenu.resetMapSelectOptions();
            this.pingTest.syncFromRegistry();
            this.checkedPingTest = false;
            this.startPingTest();
        };
        this.siteInfo.onServersUpdated = () => {
            this.pingTest.syncFromRegistry();
            this.startPingTest();
        };

        this.teamMenu = new TeamMenu(
            this.config,
            this.pingTest,
            this.siteInfo,
            this.localization,
            this.audioManager,
            this.onTeamMenuJoinGame.bind(this),
            this.onTeamMenuLeave.bind(this),
        );

        this.serverBrowser = new ServerBrowser(
            this.localization,
            (game) => this.joinPublicGame(game),
        );

        const onLoadComplete = () => {
            this.config.load(() => {
                this.configLoaded = true;
                this.tryLoad();
            });
        };
        this.loadBrowserDeps(onLoadComplete);
    }

    async loadBrowserDeps(onLoadCompleteCb: () => void) {
        await SDK.init(this);
        onLoadCompleteCb();
    }

    tryLoad() {
        if (this.domContentLoaded && this.configLoaded && !this.initialized) {
            this.initialized = true;
            setupSteamDeck();
            setupMenuGamepad();
            // this should be this.config.config.teamAutofill = true???
            // this.config.teamAutoFill = true;
            if (device.mobile) {
                Menu.applyMobileBrowserStyling(device.tablet);
            }
            if (SDK.isSpellSync) {
                this.localization.setLocale(window.spellSync.language);
                this.updateLogoBasedOnLanguage(window.spellSync.language);
            } else {
                const language = this.config.get("language") || this.localization.detectLocale();
                this.config.set("language", language);
                this.localization.setLocale(language);
                this.updateLogoBasedOnLanguage(language);
            }
            this.localization.populateLanguageSelect();
            this.startPingTest();
            this.siteInfo.load();
            this.localization.localizeIndex();
            this.account.init();

            this.nameInput.attr("maxLength", net.Constants.PlayerNameMaxLen);

            const modeBtns = [this.playMode0Btn, this.playMode1Btn, this.playMode2Btn];
            for (let i = 0; i < modeBtns.length; i++) {
                modeBtns[i].on("click", () => {
                    this.selectedGameModeIdx = i;
                    this.updateSpecOpsModeTabs();
                    return false;
                });
            }
            this.deployBtn.on("click", () => {
                SDK.requestMidGameAd(() => {
                    this.tryQuickStartGame(this.selectedGameModeIdx);
                });
                return false;
            });

            this.menuLeaderboard = new MenuLeaderboard(this.localization);
            this.menuLeaderboard.start();

            this.serverSelect.on("change", () => {
                const t = resolveServerId(this.serverSelect.find(":selected").val() as string);
                if (!t) return;
                this.serverSelect.val(t);
                this.config.set("region", t);
                this.config.set("regionSelected", true);
            });
            this.nameInput.on("blur", (_t) => {
                this.setConfigFromDOM();
            });
            this.muteBtns.on("click", (_t) => {
                this.config.set("muteAudio", !this.config.get("muteAudio"));
            });
            this.muteBtns.on("mousedown", (e) => {
                e.stopPropagation();
            });
            $(this.masterSliders).on("mousedown", (e) => {
                e.stopPropagation();
            });
            $(this.soundSliders).on("mousedown", (e) => {
                e.stopPropagation();
            });
            $(this.musicSliders).on("mousedown", (e) => {
                e.stopPropagation();
            });
            this.masterSliders.on("input", (t) => {
                const r = Number($(t.target).val()) / 100;
                this.audioManager.setMasterVolume(r);
                this.config.set("masterVolume", r);
            });
            this.soundSliders.on("input", (t) => {
                const r = Number($(t.target).val()) / 100;
                this.audioManager.setSoundVolume(r);
                this.config.set("soundVolume", r);
            });
            this.musicSliders.on("input", (t) => {
                const r = Number($(t.target).val()) / 100;
                this.audioManager.setMusicVolume(r);
                this.config.set("musicVolume", r);
            });
            this.graphicsQualitySelect.on("change", (t) => {
                const q = parseGraphicsQuality($(t.target).val());
                const adv = advancedDefaultsForQuality(q);
                // Apply preset into advanced toggles, then reload for atlas swap.
                this.config.config.graphicsQuality = q;
                this.config.config.highResTex = adv.highResTex;
                this.config.config.ambientParticles = adv.ambientParticles;
                this.config.config.simplifyDistantNpcs = adv.simplifyDistantNpcs;
                this.config.config.reduceSmokeFx = adv.reduceSmokeFx;
                this.config.config.foliageCulling = adv.foliageCulling;
                this.config.store();
                this.config.onModified("graphicsQuality");
            });
            this.renderScaleSlider.on("mousedown", (e) => {
                e.stopPropagation();
            });
            this.renderScaleSlider.on("input", (t) => {
                const pct = Number($(t.target).val());
                this.config.set("renderScale", clampRenderScale(pct / 100));
            });
            $(".modal-settings-item")
                .children("input")
                .each((_t, r) => {
                    const a = $(r);
                    a.prop("checked", this.config.get(a.prop("id")));
                });
            $(".modal-settings-item > input:checkbox").on("change", (t) => {
                const r = $(t.target);
                this.config.set(r.prop("id"), r.is(":checked"));
            });
            $(".btn-fullscreen-toggle").on("click", () => {
                helpers.toggleFullScreen();
            });
            this.languageSelect.on("change", (t) => {
                const r = t.target.value;
                if (r) {
                    this.config.set("language", r as ConfigType["language"]);
                    if (SDK.isSpellSync && window.spellSync) {
                        window.spellSync.changeLanguage(r);
                    }
                    this.updateLogoBasedOnLanguage(r);
                }
            });
            $("#btn-create-team").on("click", () => {
                // Carry start-menu Solo/Duo/Squad + selected server into the lobby.
                this.config.set("gameModeIdx", this.selectedGameModeIdx);
                this.setConfigFromDOM();
                this.tryJoinTeam(true);
            });
            $("#btn-team-mobile-link-join").on("click", () => {
                let t = $<HTMLInputElement>("#team-link-input").val()!.trim()!;
                const r = t.indexOf("#");
                if (r >= 0) {
                    t = t.slice(r + 1);
                }
                if (t.length > 0) {
                    $("#team-mobile-link").css("display", "none");
                    this.tryJoinTeam(false, t);
                } else {
                    $("#team-mobile-link-desc").css("display", "none");
                    $("#team-mobile-link-warning").css("display", "none").fadeIn(100);
                }
            });
            $("#btn-team-leave").on("click", () => {
                if (window.history) {
                    window.history.replaceState("", "", "/");
                }
                $("#news-block").css("display", "block");
                this.game?.free();
                this.teamMenu.leave();
            });

            // Spec Ops menu: hide legacy pass/news sidebar
            $("#pass-wrapper, #news-wrapper, .right-column-toggle").hide();
            this.newsDisplayed = false;

            const loginSupported = !SDK.isAnySDK && proxy.anyLoginSupported();
            if (loginSupported) {
                $("#news-wrapper").hide();
                $("#pass-wrapper").hide();
            }
            this.setDOMFromConfig();
            this.setAppActive(true);
            const domCanvas = document.querySelector<HTMLCanvasElement>("#cvs")!;

            const gfxProfile = resolveGraphicsProfile(
                parseGraphicsQuality(this.config.get("graphicsQuality")),
                clampRenderScale(this.config.get("renderScale")),
                {
                    highResTex: !!this.config.get("highResTex"),
                    foliageCulling: !!this.config.get("foliageCulling"),
                    ambientParticles: !!this.config.get("ambientParticles"),
                    simplifyDistantNpcs: !!this.config.get("simplifyDistantNpcs"),
                    reduceSmokeFx: !!this.config.get("reduceSmokeFx"),
                    uncapFps: !!this.config.get("uncapFps"),
                },
            );
            this.audioManager.setMaxVoices(gfxProfile.audioMaxVoices);
            const rendererRes = pixiResolution(gfxProfile);

            if (device.os == "ios") {
                PIXI.settings.PRECISION_FRAGMENT = PIXI.PRECISION.HIGH;
            }

            const createPixiApplication = (forceCanvas: boolean) => {
                return new PIXI.Application({
                    width: window.innerWidth,
                    height: window.innerHeight,
                    view: domCanvas,
                    antialias: false,
                    resolution: rendererRes,
                    powerPreference: "high-performance",
                    hello: true,
                    forceCanvas,
                });
            };
            let pixi = null;
            try {
                pixi = createPixiApplication(false);
            } catch (_e) {
                pixi = createPixiApplication(true);
            }
            this.pixi = pixi;
            this.pixi.renderer.events.destroy();
            // Cap sim/render at 60 unless the player uncapped FPS in settings.
            this.pixi.ticker.maxFPS = gfxProfile.uncapFps ? 0 : 60;
            this.pixi.ticker.add(this.update, this);
            this.pixi.renderer.background.color = 7378501;
            this.resourceManager = new ResourceManager(
                this.pixi.renderer,
                this.audioManager,
                this.config,
            );
            this.resourceManager.loadMapAssets("main");
            this.input = new InputHandler(document.getElementById("game-touch-area")!);
            this.inputBinds = new InputBinds(this.input, this.config);
            this.inputBindUi = new InputBindUi(
                this.input,
                this.inputBinds,
                this.localization,
            );
            const onJoin = () => {
                this.loadoutDisplay!.free();
                this.menuLeaderboard.stop();
                this.game!.init();
                this.onResize();
                this.findGameAttempts = 0;
                this.ambience.onGameStart();
                clearRejoinUrlParams();
                this.hideRejoinBanner();
            };
            const onQuit = (
                errMsg?: GameWsDisconnectReason,
                opts?: { canRejoin: boolean },
            ) => {
                const canRejoin = !!opts?.canRejoin;
                if (this.game!.m_updatePass) {
                    this.pass.scheduleUpdatePass(this.game!.m_updatePassDelay);
                }
                this.game!.free();
                this.errorMessage = errMsg ? this.getErrorString(errMsg, "host_closed") : "";
                this.teamMenu.onGameComplete(this.errorMessage);
                this.ambience.onGameComplete(this.audioManager);
                this.setAppActive(true);
                this.setPlayLockout(false);
                this.menuLeaderboard.start();

                if (canRejoin) {
                    void this.onMatchDisconnectRejoin();
                } else {
                    this.clearRejoinPending();
                    clearMatchSession();
                    clearRejoinUrlParams();
                    this.hideRejoinBanner();
                }

                if (errMsg == "invalid_protocol") {
                    this.showInvalidProtocolModal();
                }
                if (errMsg == "behind_proxy" || errMsg == "ip_banned") {
                    this.showErrorModal(errMsg);
                }
                if (errMsg) {
                    console.warn("Quitting", errMsg);
                }

                SDK.gamePlayStop();
            };
            this.game = new Game(
                this.pixi,
                this.audioManager,
                this.localization,
                this.config,
                this.input,
                this.inputBinds,
                this.inputBindUi,
                this.ambience,
                this.resourceManager,
                onJoin,
                onQuit,
            );
            this.game.editor?.setDebugAllowed(!!this.siteInfo.info.allowEditMsg);
            this.game.editor?.setSpecOpsNpcSpawn(!!this.siteInfo.info.specOpsNpcSpawn);
            this.loadoutDisplay = new LoadoutDisplay(
                this.pixi,
                this.audioManager,
                this.config,
                this.inputBinds,
                this.account,
            );
            this.loadoutMenu.loadoutDisplay = this.loadoutDisplay;
            this.onResize();
            this.setupRejoinUi();
            this.tryRestoreSessionOnLoad();
            this.tryJoinTeam(false);
            Menu.setupModals(this.inputBinds, this.inputBindUi);
            this.onConfigModified();
            this.config.addModifiedListener(this.onConfigModified.bind(this));
            loadStaticDomImages();
            this.setupCommunityAnnouncement();

            SDK.gameLoadComplete();
        }
    }

    private communityAnnounceSessionKey() {
        return `specops_announce_session_${COMMUNITY_ANNOUNCEMENT_VERSION}`;
    }

    private shouldShowCommunityAnnouncement() {
        try {
            if (sessionStorage.getItem(this.communityAnnounceSessionKey()) === "1") {
                return false;
            }
        } catch (_e) {}
        const hideUntil = Number(this.config.get("announcementHideUntil") || 0);
        const seenVer = Number(this.config.get("announcementVersionSeen") || 0);
        if (
            seenVer >= COMMUNITY_ANNOUNCEMENT_VERSION
            && hideUntil > Date.now()
        ) {
            return false;
        }
        return true;
    }

    setupCommunityAnnouncement() {
        $("#btn-community-announce-close").on("click", () => {
            try {
                sessionStorage.setItem(this.communityAnnounceSessionKey(), "1");
            } catch (_e) {}
            this.communityAnnounceModal.hide();
        });
        $("#btn-community-announce-snooze").on("click", () => {
            this.config.set(
                "announcementHideUntil",
                Date.now() + COMMUNITY_ANNOUNCEMENT_SNOOZE_MS,
            );
            this.config.set("announcementVersionSeen", COMMUNITY_ANNOUNCEMENT_VERSION);
            try {
                sessionStorage.setItem(this.communityAnnounceSessionKey(), "1");
            } catch (_e) {}
            this.communityAnnounceModal.hide();
        });
        this.communityAnnounceModal.onHide(() => {
            try {
                sessionStorage.setItem(this.communityAnnounceSessionKey(), "1");
            } catch (_e) {}
        });
        if (this.shouldShowCommunityAnnouncement()) {
            // Slight delay so the start menu paints first.
            setTimeout(() => {
                if (this.active && this.shouldShowCommunityAnnouncement()) {
                    this.communityAnnounceModal.show(true);
                }
            }, 600);
        }
    }

    private resolveActiveGraphicsProfile() {
        return resolveGraphicsProfile(
            parseGraphicsQuality(this.config.get("graphicsQuality")),
            clampRenderScale(this.config.get("renderScale")),
            {
                highResTex: !!this.config.get("highResTex"),
                foliageCulling: !!this.config.get("foliageCulling"),
                ambientParticles: !!this.config.get("ambientParticles"),
                simplifyDistantNpcs: !!this.config.get("simplifyDistantNpcs"),
                reduceSmokeFx: !!this.config.get("reduceSmokeFx"),
                uncapFps: !!this.config.get("uncapFps"),
            },
        );
    }

    private applyLiveGraphicsSettings() {
        const profile = this.resolveActiveGraphicsProfile();
        if (this.pixi) {
            this.pixi.ticker.maxFPS = profile.uncapFps ? 0 : 60;
            this.pixi.renderer.resolution = pixiResolution(profile);
            this.pixi.renderer.resize(window.innerWidth, window.innerHeight);
        }
        this.audioManager.setMaxVoices(profile.audioMaxVoices);
        if (this.game) {
            this.game.applyGraphicsProfile(profile);
        }
    }

    onUnload() {
        if (this.game?.canRejoinMatch()) {
            markMatchDisconnected();
        }
    }

    onResize() {
        device.onResize();
        Menu.onResize();
        this.loadoutMenu.onResize();
        this.pixi?.renderer.resize(device.screenWidth, device.screenHeight);
        if (this.game?.initialized) {
            this.game.resize();
        }
        if (this.loadoutDisplay?.initialized) {
            this.loadoutDisplay.resize();
        }
        this.refreshUi();
    }

    startPingTest() {
        const regions = this.config.get("regionSelected")
            ? [this.config.get("region")!]
            : this.pingTest.getRegionList();
        this.pingTest.start(regions);
    }

    setAppActive(active: boolean) {
        this.active = active;
        this.quickPlayPendingModeIdx = -1;
        this.refreshUi();

        if (!active) {
            focusGameCanvas();
        }

        // Certain systems, like the account, can throw errors
        // while the user is already in a game.
        // Seeing these errors when returning to the menu would be
        // confusing, so we'll hide the modal instead.
        if (active) {
            this.errorModal.hide();
        }
    }

    setPlayLockout(lock: boolean) {
        let delay = lock ? 0 : 1000;
        if (IS_DEV) {
            delay = 0;
        }
        this.playButtons
            .stop()
            .delay(delay)
            .animate(
                {
                    opacity: lock ? 0.5 : 1,
                },
                IS_DEV ? 0 : 250,
            );
        this.playLoading
            .stop()
            .delay(delay)
            .animate(
                {
                    opacity: lock ? 1 : 0,
                },
                {
                    duration: IS_DEV ? 0 : 250,
                    start: () => {
                        this.playLoading.css({
                            "pointer-events": lock ? "initial" : "none",
                        });
                    },
                },
            );
    }

    onTeamMenuJoinGame(data: FindGameMatchData) {
        this.clearRejoinPending();
        this.activeMatchMeta = {
            region: this.teamMenu.roomData.region || this.config.get("region")!,
            gameModeIdx: this.teamMenu.roomData.gameModeIdx,
            teamRoomUrl: resolveTeamRoomUrl({
                teamRoomUrl: this.teamMenu.roomData.roomUrl,
            }),
        };
        this.waitOnAccount(() => {
            this.joinGame(data);
        });
    }

    onTeamMenuLeave(errTxt?: string) {
        if (errTxt && window.history) {
            window.history.replaceState("", "", "/");
        }

        this.errorMessage = errTxt || "";
        this.setDOMFromConfig();
        this.refreshUi();
    }

    // Config
    setConfigFromDOM() {
        const playerName = helpers.sanitizeNameInput(this.nameInput.val() as string);
        this.config.set("playerName", playerName);
        const selected = this.serverSelect.find(":selected").val() as string | undefined;
        const region = resolveServerId(selected || this.config.get("region"));
        if (region) {
            this.serverSelect.val(region);
            this.config.set("region", region);
            this.config.set("regionSelected", true);
        }
    }

    setDOMFromConfig() {
        if (SDK.isAnySDK && !this.config.get("playerName")) {
            SDK.getPlayerName().then((username) => {
                if (!username) return;
                this.config.set("playerName", username);
                this.nameInput.val(username);
            });
        }

        this.nameInput.val(this.config.get("playerName")!);
        const region = resolveServerId(this.config.get("region"));
        if (region && region !== this.config.get("region")) {
            this.config.set("region", region);
        }
        this.serverSelect.find("option").each((_i, ele) => {
            const spellSyncLang = SDK.isSpellSync && window.spellSync.language;
            ele.selected = spellSyncLang
                ? ele.value === spellSyncLang
                : ele.value === region;
        });
        if (region && !this.serverSelect.find(":selected").val()) {
            this.serverSelect.val(region);
        }
        this.languageSelect.val(this.localization.getLocale());
        this.graphicsQualitySelect.val(
            parseGraphicsQuality(this.config.get("graphicsQuality")),
        );
        this.renderScaleSlider.val(
            Math.round(clampRenderScale(this.config.get("renderScale")) * 100),
        );
    }

    onConfigModified(key?: string) {
        const muteAudio = this.config.get("muteAudio")!;
        if (muteAudio != this.audioManager.mute) {
            this.muteBtns.removeClass(muteAudio ? "audio-on-icon" : "audio-off-icon");
            this.muteBtns.addClass(muteAudio ? "audio-off-icon" : "audio-on-icon");
            this.audioManager.setMute(muteAudio);
        }

        const masterVolume = this.config.get("masterVolume")!;
        this.masterSliders.val(masterVolume * 100);
        this.audioManager.setMasterVolume(masterVolume);

        const soundVolume = this.config.get("soundVolume")!;
        this.soundSliders.val(soundVolume * 100);
        this.audioManager.setSoundVolume(soundVolume);

        const musicVolume = this.config.get("musicVolume")!;
        this.musicSliders.val(musicVolume * 100);
        this.audioManager.setMusicVolume(musicVolume);

        if (key == "language") {
            const language = this.config.get("language")!;
            this.localization.setLocale(language);
            this.updateLogoBasedOnLanguage(language);
        }

        if (key == "region") {
            this.config.set("regionSelected", true);
            this.startPingTest();
        }

        if (key == "graphicsQuality") {
            location.reload();
            return;
        }

        if (key == "highResTex") {
            location.reload();
            return;
        }

        if (
            key == "renderScale"
            || key == "uncapFps"
            || key == "foliageCulling"
            || key == "ambientParticles"
            || key == "simplifyDistantNpcs"
            || key == "reduceSmokeFx"
        ) {
            this.applyLiveGraphicsSettings();
        }

        if (key === "debugHUD") {
            this.game?.debugHUD?.onConfigModified();
        }
    }

    refreshUi() {
        this.startMenuWrapper.css("display", this.active ? "flex" : "none");
        this.gameAreaWrapper.css({
            display: this.active ? "none" : "block",
            opacity: this.active ? 0 : 1,
        });
        if (this.active) {
            $("body").removeClass("user-select-none");
            document.removeEventListener("contextmenu", this.contextListener);
        } else {
            $("body").addClass("user-select-none");
            $("#start-main").stop(true);
            document.addEventListener("contextmenu", this.contextListener);
        }

        // Hide the left section if on mobile, oriented portrait, and viewing create team
        $("#ad-block-left").css(
            "display",
            !device.isLandscape && this.teamMenu.active ? "none" : "block",
        );

        // Warning
        const hasError = !this.teamMenu.active && this.errorMessage != "";
        this.serverWarning.css({
            display: "block",
            opacity: hasError ? 1 : 0,
        });
        if (!this.teamMenu.active) {
            this.serverWarning.html(this.errorMessage);
        }

        const updateButton = (_ele: JQuery<HTMLElement>, _gameModeIdx: number) => {};

        updateButton(this.playMode0Btn, 0);
        updateButton(this.playMode1Btn, 1);
        updateButton(this.playMode2Btn, 2);
        this.updateSpecOpsModeTabs();
        this.updateSpecOpsDeployBtn();
    }

    updateSpecOpsModeTabs() {
        const tabs = [this.playMode0Btn, this.playMode1Btn, this.playMode2Btn];
        for (let i = 0; i < tabs.length; i++) {
            tabs[i].toggleClass("is-active", i === this.selectedGameModeIdx);
        }
    }

    updateSpecOpsDeployBtn() {
        const label = this.deployBtn.find(".specops-deploy-label");
        const loading = this.quickPlayPendingModeIdx !== -1;
        this.deployBtn.toggleClass("is-loading", loading);
        if (loading) {
            label.html("<div class=\"ui-spinner\"></div>");
        } else {
            label.text(this.localization.translate("index-specops-deploy-now"));
        }
    }

    waitOnAccount(cb: () => void) {
        if (this.account.requestsInFlight == 0) {
            cb();
        } else {
            // Wait some maximum amount of time for pending account requests
            const timeout = setTimeout(() => {
                runOnce();
                errorLogManager.storeGeneric("account", "wait_timeout");
            }, 2500);
            const runOnce = () => {
                cb();
                clearTimeout(timeout);
                this.account.removeEventListener("requestsComplete", runOnce);
            };
            this.account.addEventListener("requestsComplete", runOnce);
        }
    }

    tryJoinTeam(create: boolean, url?: string) {
        if (this.active && this.quickPlayPendingModeIdx === -1) {
            // Join team if the url contains a team address
            let roomUrl = url || window.location.hash.slice(1);

            if (!roomUrl && !create) {
                const lobby = getTeamLobbySession();
                if (lobby?.roomUrl) {
                    roomUrl = lobby.roomUrl.replace(/^#/, "");
                }
            }

            const sdkRoom = SDK.getRoomInviteParam();
            if (sdkRoom) {
                roomUrl = sdkRoom;
                create = false;
            }

            if (create || roomUrl != "") {
                const incomingKey = normalizeTeamRoomKey(roomUrl);
                const currentKey = normalizeTeamRoomKey(this.teamMenu.roomData.roomUrl || "");
                if (
                    create
                    && this.teamMenu.active
                    && this.teamMenu.isWsLive()
                ) {
                    return;
                }
                if (
                    !create
                    && this.teamMenu.active
                    && incomingKey
                    && incomingKey === currentKey
                    && (this.teamMenu.joined || this.teamMenu.isWsLive())
                ) {
                    this.teamMenu.ensureConnected();
                    return;
                }

                // The main menu and squad menus have separate
                // DOM elements for input, such as player name and
                // selected region. We will stash the menu values
                // into the config so the team menu can read them.
                this.setConfigFromDOM();
                this.teamMenu.connect(create, roomUrl);
                this.refreshUi();
            }
        }
    }

    teamModeToGameModeIdx(teamMode: TeamMode): number {
        const modes = this.siteInfo.info.modes || [];
        for (let i = 0; i < modes.length; i++) {
            if (modes[i].teamMode === teamMode) return i;
        }
        if (teamMode === TeamMode.Duo) return 1;
        if (teamMode === TeamMode.Squad) return 2;
        return 0;
    }

    joinPublicGame(game: PublicGameInfo) {
        requestSteamDeckFullscreen();
        this.setConfigFromDOM();
        this.errorMessage = "";
        this.quickPlayPendingModeIdx = this.teamModeToGameModeIdx(game.teamMode as TeamMode);
        this.refreshUi();

        const version = GameConfig.protocolVersion;
        const region = game.region || this.config.get("region")!;
        const zones = this.pingTest.getZones(region);

        const matchArgs: FindGameBody = {
            version,
            region,
            zones,
            playerCount: 1,
            
            //Keep autofill on after a player joins from browse option
            autoFill: true,
            
            gameModeIdx: this.quickPlayPendingModeIdx,
            gameId: game.gameId,
        };

        this.waitOnAccount(() => {
            this.findGame(matchArgs, {
                error: (err) => this.onJoinGameError(err),
                success: (data) => this.joinGame(data),
                ban: (ban) => this.showIpBanModal(ban),
            });
        });
    }

    tryQuickStartGame(gameModeIdx: number) {
        if (this.quickPlayPendingModeIdx === -1) {
            requestSteamDeckFullscreen();
            // Update UI to display a spinner on the play button
            this.errorMessage = "";
            this.quickPlayPendingModeIdx = gameModeIdx;
            this.setConfigFromDOM();
            this.refreshUi();

            // Wait some amount of time if we've recently attempted to
            // find a game to prevent spamming the server
            let delay = 0;
            if (this.findGameAttempts > 0 && Date.now() - this.findGameTime < 30000) {
                delay = Math.min(this.findGameAttempts * 2.5 * 1000, 7500);
            } else {
                this.findGameAttempts = 0;
            }
            this.findGameTime = Date.now();
            this.findGameAttempts++;

            // the delay is annoying on dev
            if (IS_DEV) {
                delay = 0;
            }

            const version = GameConfig.protocolVersion;
            let region = this.config.get("region")!;
            const paramRegion = helpers.getParameterByName("region");
            if (paramRegion !== undefined && paramRegion.length > 0) {
                region = paramRegion;
            }
            let zones = this.pingTest.getZones(region);
            const paramZone = helpers.getParameterByName("zone");
            if (paramZone !== undefined && paramZone.length > 0) {
                zones = [paramZone];
            }

            const matchArgs: FindGameBody = {
                version,
                region,
                zones,
                playerCount: 1,
                autoFill: true,
                gameModeIdx,
                difficulty: parseSpecOpsDifficulty(
                    this.config.get("teamDifficulty")
                        || this.siteInfo.info.specOpsDifficulty
                        || "regular",
                ),
                endless: (() => {
                    const saved = this.config.get("teamEndless");
                    if (typeof saved === "boolean") return saved;
                    return this.siteInfo.info.specOpsEndless ?? false;
                })(),
            };

            this.activeMatchMeta = { region, gameModeIdx };

            const tryQuickStartGameImpl = () => {
                this.waitOnAccount(() => {
                    this.findGame(matchArgs, {
                        error: (err) => {
                            this.onJoinGameError(err);
                        },
                        success: (data) => {
                            this.joinGame(data);
                        },
                        ban: (ban) => {
                            this.showIpBanModal(ban);
                        },
                    });
                });
            };

            if (delay == 0) {
                // We can improve findGame responsiveness by ~30 ms by skipping
                // the 0ms setTimeout
                tryQuickStartGameImpl();
            } else {
                setTimeout(() => {
                    tryQuickStartGameImpl();
                }, delay);
            }
        }
    }

    findGame(
        matchArgs: FindGameBody,
        cbs: {
            error: (err: FindGameError) => void;
            success: (matchData: FindGameMatchData) => void;
            ban: (data: FindGameResponse & { type: "banned" }) => void;
        },
    ) {
        this.findGameAbort?.abort();
        const abort = new AbortController();
        this.findGameAbort = abort;

        const findGameImpl = (iter: number, maxAttempts: number, token: string) => {
            if (abort.signal.aborted) return;
            if (iter >= maxAttempts) {
                cbs.error("full");
                return;
            }
            const retry = () => {
                if (abort.signal.aborted) return;
                setTimeout(() => {
                    helpers.verifyTurnstile(
                        this.siteInfo.info.captchaEnabled && !this.account.loggedIn,
                        (token) => {
                            findGameImpl(iter + 1, maxAttempts, token);
                        },
                    );
                }, 500);
            };
            matchArgs.turnstileToken = token;

            const timeout = setTimeout(() => abort.abort(), 10_000);
            fetch(api.resolveUrl("/api/find_game_v2"), {
                method: "POST",
                body: JSON.stringify(matchArgs),
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                },
                credentials: proxy.anyLoginSupported() ? "include" : "omit",
                signal: abort.signal,
            }).then(res => res.json()).then(async (data: FindGameResponse) => {
                clearTimeout(timeout);
                if (abort.signal.aborted) return;
                if (data.type === "error") {
                    cbs.error(data.error);
                } else if (data.type === "banned") {
                    cbs.ban(data);
                } else if (data.type === "success") {
                    cbs.success(data.res);
                } else if (data.type === "session") {
                    // Complete matchmaking on the region host — master is not involved.
                    const findUrl = api.resolveSessionFindUrl(data.res.findUrl);
                    try {
                        const sessionRes = await fetch(findUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ ticket: data.res.ticket }),
                            signal: abort.signal,
                        });
                        const body = await sessionRes.json() as {
                            error?: FindGameError;
                            gameId?: string;
                            urls?: string[];
                        };
                        if (abort.signal.aborted) return;
                        if (!sessionRes.ok || body.error || !body.gameId || !body.urls) {
                            cbs.error(body.error || "find_game_failed");
                            return;
                        }
                        cbs.success({
                            zone: "",
                            data: data.res.data,
                            gameId: body.gameId,
                            urls: body.urls,
                        });
                    } catch {
                        if (abort.signal.aborted) return;
                        retry();
                    }
                }
            }).catch(() => {
                clearTimeout(timeout);
                if (abort.signal.aborted) return;
                retry();
            });
        };

        helpers.verifyTurnstile(
            this.siteInfo.info.captchaEnabled && !this.account.loggedIn,
            (token) => {
                findGameImpl(0, 2, token);
            },
        );
    }

    joinGame(matchData: FindGameMatchData) {
        if (!this.game) {
            setTimeout(() => {
                this.joinGame(matchData);
            }, 250);
            return;
        }
        const urls = api.resolveGameWsUrls(matchData.urls);
        if (IS_DEV) {
            console.log("[join] trying game URLs:", [...urls]);
        }

        const region = this.activeMatchMeta?.region
            ?? this.config.get("region")!
            ?? matchData.zone;
        const gameModeIdx = this.activeMatchMeta?.gameModeIdx ?? this.selectedGameModeIdx;
        const teamRoomUrl = this.teamMenu.active
            ? this.teamMenu.roomData.roomUrl
            : this.activeMatchMeta?.teamRoomUrl;
        const prevSession = getActiveMatchSession() ?? getRejoinSession();
        saveActiveMatch({
            gameId: matchData.gameId,
            region,
            gameModeIdx,
            playerName: prevSession?.playerName || this.config.get("playerName")!,
            playerId: prevSession?.playerId,
            teamRoomUrl,
        });
        this.activeMatchMeta = { region, gameModeIdx, teamRoomUrl };

        const joinGameImpl = (urls: string[], matchData: FindGameMatchData) => {
            const url = urls.shift();
            if (!url) {
                this.onJoinGameError("join_game_failed");
                return;
            }
            const onFailure = function() {
                joinGameImpl(urls, matchData);
            };
            this.game!.tryJoinGame(
                url,
                matchData.data,
                onFailure,
            );
        };
        joinGameImpl(urls, matchData);
    }

    setupRejoinUi() {
        this.rejoinBtn.on("click", (e) => {
            e.preventDefault();
            void this.attemptMatchRejoin();
        });
        this.rejoinDismissBtn.on("click", (e) => {
            e.preventDefault();
            this.leaveMatchFromRejoinPrompt();
        });
    }

    /** Player chose Leave — drop reclaim session and return to lobby/menu. */
    private leaveMatchFromRejoinPrompt() {
        this.clearRejoinPending();
        this.activeMatchMeta = null;
        clearMatchSession();
        clearRejoinUrlParams();
        this.hideRejoinBanner();
        if (this.teamMenu.active) {
            this.teamMenu.sendMessage("gameComplete", {});
            this.teamMenu.clearMatchJoinState();
        }
        this.errorMessage = "";
        this.refreshUi();
    }

    private clearRejoinPending() {
        this.rejoinPending = false;
        if (this.rejoinWatchdog) {
            clearTimeout(this.rejoinWatchdog);
            this.rejoinWatchdog = null;
        }
    }

    private armRejoinWatchdog() {
        if (this.rejoinWatchdog) clearTimeout(this.rejoinWatchdog);
        this.rejoinWatchdog = setTimeout(() => {
            this.rejoinWatchdog = null;
            if (!this.rejoinPending) return;
            // Team rejoin never delivered joinGame — try solo token path.
            this.rejoinPending = false;
            this.teamMenu.clearMatchJoinState();
            void this.attemptSoloMatchRejoin();
        }, 8_000);
    }

    /** Direct find_game rejoin using stored gameId (works for solo and as team fallback). */
    private async attemptSoloMatchRejoin() {
        const session = getRejoinSession();
        if (!session) {
            this.hideRejoinBanner();
            return;
        }
        if (!session.token) {
            const ok = await this.fetchRejoinToken(session);
            if (!ok) {
                this.errorMessage = this.localization.translate("index-rejoin-expired");
                this.refreshUi();
                this.showRejoinBanner(getRejoinSession() ?? session);
                return;
            }
        }
        const ready = getRejoinSession();
        if (!ready?.token) {
            this.showRejoinBanner(session);
            return;
        }

        this.rejoinPending = true;
        this.armRejoinWatchdog();
        this.hideRejoinBanner();
        this.errorMessage = "";
        this.activeMatchMeta = {
            region: ready.region,
            gameModeIdx: ready.gameModeIdx,
            teamRoomUrl: resolveTeamRoomUrl(ready),
        };
        this.setAppActive(false);
        this.joinGame({
            zone: ready.region,
            gameId: ready.gameId,
            urls: ready.urls ?? [],
            data: ready.token,
        });
        this.clearRejoinPending();
    }

    async attemptMatchRejoin() {
        if (this.rejoinPending) return;
        const session = getRejoinSession();
        if (!session) {
            this.hideRejoinBanner();
            return;
        }

        const teamCode = teamRoomCode(session);
        if (teamCode) {
            this.ensureTeamLobbyForRejoin(teamCode);
            if (this.teamMenu.requestMatchRejoin()) {
                this.rejoinPending = true;
                this.armRejoinWatchdog();
                this.hideRejoinBanner();
                this.errorMessage = "";
                this.activeMatchMeta = {
                    region: session.region,
                    gameModeIdx: session.gameModeIdx,
                    teamRoomUrl: resolveTeamRoomUrl(session),
                };
                return;
            }
        }

        await this.attemptSoloMatchRejoin();
    }

    tryRestoreSessionOnLoad() {
        const urlSession = parseRejoinFromLocation();
        ensureRejoinAfterReload();
        const stored = getRejoinSession();
        let session = mergeRejoinSessions(urlSession, stored);
        if (!session) return;

        const playerName = this.config.get("playerName")!;
        if (!session.playerName && playerName) {
            session.playerName = playerName;
        }
        if (urlSession || stored) {
            persistRejoinSession(session);
        }

        const teamCode = session.teamRoomUrl?.replace(/^#/, "");
        if (teamCode) {
            this.tryJoinTeam(false, teamCode);
        }

        // Offer choice only — never force reconnect.
        this.showRejoinBanner(getRejoinSession() ?? session);
    }

    async onMatchDisconnectRejoin() {
        markMatchDisconnected();
        const session = getRejoinSession();
        if (!session) return;

        const teamCode = teamRoomCode(session);
        if (teamCode) {
            if (
                !this.teamMenu.active
                || normalizeTeamRoomKey(this.teamMenu.roomData.roomUrl) !== normalizeTeamRoomKey(teamCode)
            ) {
                this.tryJoinTeam(false, teamCode);
            } else {
                this.teamMenu.ensureConnected();
            }
        }

        // Offer choice only — never force reconnect.
        this.showRejoinBanner(session);
    }

    async fetchRejoinToken(session: ActiveMatchSession): Promise<boolean> {
        if (this.fetchRejoinTokenPromise) {
            return this.fetchRejoinTokenPromise;
        }

        this.fetchRejoinTokenPromise = this.fetchRejoinTokenImpl(session);
        try {
            return await this.fetchRejoinTokenPromise;
        } finally {
            this.fetchRejoinTokenPromise = null;
        }
    }

    private fetchRejoinTokenImpl(session: ActiveMatchSession): Promise<boolean> {
        const teamRoomUrl = resolveTeamRoomUrl(session);
        const meta = this.activeMatchMeta ?? {
            region: session.region,
            gameModeIdx: session.gameModeIdx,
            teamRoomUrl,
        };

        return new Promise((resolve) => {
                this.findGame(
                {
                    version: GameConfig.protocolVersion,
                    region: meta.region,
                    zones: this.pingTest.getZones(meta.region),
                    playerCount: 1,
                    autoFill: false,
                    gameModeIdx: meta.gameModeIdx,
                    gameId: session.gameId,
                    reclaimPlayerId: session.playerId,
                },
                {
                    error: () => resolve(false),
                    success: (data) => {
                        storeRejoinToken(
                            data,
                            meta.region,
                            meta.gameModeIdx,
                            session.playerName || this.config.get("playerName")!,
                            meta.teamRoomUrl,
                        );
                        const stored = getRejoinSession();
                        if (stored && session.playerId) {
                            stored.playerId = session.playerId;
                            persistRejoinSession(stored);
                        }
                        syncRejoinUrl(getRejoinSession()!);
                        this.showRejoinBanner(getRejoinSession()!);
                        resolve(true);
                    },
                    ban: () => resolve(false),
                },
            );
        });
    }

    private ensureTeamLobbyForRejoin(teamCode: string) {
        if (
            !this.teamMenu.active
            || normalizeTeamRoomKey(this.teamMenu.roomData.roomUrl) !== normalizeTeamRoomKey(teamCode)
        ) {
            this.tryJoinTeam(false, teamCode);
            return;
        }
        this.teamMenu.ensureConnected();
    }

    showRejoinBanner(session: ActiveMatchSession) {
        const left = rejoinSecondsLeft(session);
        if (left <= 0) {
            this.hideRejoinBanner();
            return;
        }
        const prompt = this.localization
            .translate("index-rejoin-prompt")
            .replace("{0}", String(left));
        this.rejoinPromptText.text(prompt || `Your match is still running. Reconnect within ${left}s, or leave.`);
        this.rejoinBanner.css("display", "flex");
        syncRejoinUrl(session);

        if (this.rejoinTicker) clearInterval(this.rejoinTicker);
        this.rejoinTicker = setInterval(() => {
            const current = getRejoinSession();
            if (!current) {
                this.hideRejoinBanner();
                return;
            }
            const secs = rejoinSecondsLeft(current);
            if (secs <= 0) {
                this.hideRejoinBanner();
                return;
            }
            const tickPrompt = this.localization
                .translate("index-rejoin-prompt")
                .replace("{0}", String(secs));
            this.rejoinPromptText.text(
                tickPrompt || `Your match is still running. Reconnect within ${secs}s, or leave.`,
            );
        }, 500);
    }

    hideRejoinBanner() {
        if (this.rejoinTicker) {
            clearInterval(this.rejoinTicker);
            this.rejoinTicker = null;
        }
        this.rejoinBanner.css("display", "none");
    }

    getErrorString(err: FindGameError | GameWsDisconnectReason, fallback: "host_closed" | "full") {
        const errMap: Partial<Record<FindGameError | GameWsDisconnectReason, string>> = {
            banned: this.localization.translate("index-ip-banned"),
            behind_proxy: this.localization.translate("index-behind-proxy"),
            find_game_failed: this.localization.translate("index-failed-finding-game"),
            full: this.localization.translate("index-failed-finding-game"),
            host_closed: this.localization.translate("index-host-closed"),
            invalid_captcha: this.localization.translate("index-invalid-captcha"),
            invalid_packet: this.localization.translate("index-invalid-packet"),
            invalid_protocol: this.localization.translate("index-invalid-protocol"),
            ip_banned: this.localization.translate("index-ip-banned"),
            join_game_failed: this.localization.translate("index-failed-joining-game"),
            rate_limited: this.localization.translate("index-rate-limited"),
            server_crashed: this.localization.translate("index-server-crashed"),
            server_restart: this.localization.translate("index-server-restart"),
        };
        return errMap[err] || errMap[fallback]!;
    }

    onJoinGameError(err: FindGameError) {
        if (err == "invalid_protocol") {
            this.showInvalidProtocolModal();
        }

        // Forcefully set captcha to enabled if we fail the captcha
        // This can happen if it was disabled when the page loaded which would meant it was sending an empty token
        // And we only fetch the state when the page loads...
        if (err === "invalid_captcha") {
            this.siteInfo.info.captchaEnabled = true;
        }
        if (err == "behind_proxy" || err == "banned") {
            this.showErrorModal(err);
        }

        this.errorMessage = this.getErrorString(err, "full");
        this.quickPlayPendingModeIdx = -1;
        this.clearRejoinPending();
        this.teamMenu.clearMatchJoinState();
        const rejoinSession = getRejoinSession();
        if (!rejoinSession) {
            this.activeMatchMeta = null;
            clearMatchSession();
            clearRejoinUrlParams();
            this.hideRejoinBanner();
        } else {
            this.showRejoinBanner(rejoinSession);
        }
        if (this.teamMenu.active && this.teamMenu.isWsLive()) {
            this.teamMenu.onGameComplete(this.errorMessage);
        } else {
            this.teamMenu.leave("join_game_failed");
        }
        this.refreshUi();
    }

    showInvalidProtocolModal() {
        this.refreshModal.show(true);
    }

    showIpBanModal(ban: FindGameResponse & { type: "banned" }) {
        $("#modal-ip-banned-reason").text(`Reason: ${ban.reason}`);

        let expiration = "Duration: indefinite";
        if (!ban.permanent) {
            const expiresIn = new Date(ban.expiresIn);
            const timeLeft = expiresIn.getTime() - Date.now();

            const daysLeft = Math.round(timeLeft / (1000 * 60 * 60 * 24));
            const hoursLeft = Math.round(timeLeft / (1000 * 60 * 60));

            if (daysLeft > 1) {
                expiration = `Expires in: ${daysLeft} days`;
            } else if (hoursLeft > 1) {
                expiration = `Expires in: ${hoursLeft} hours`;
            } else {
                expiration = `Expires in: less than an hour`;
            }
        }

        $("#modal-ip-banned-expiration").text(expiration);

        this.ipBanModal.show(true);

        this.quickPlayPendingModeIdx = -1;
        this.teamMenu.leave("banned");
        this.refreshUi();
    }

    showErrorModal(err: FindGameError | GameWsDisconnectReason) {
        const text = this.getErrorString(err, "full");
        if (text) {
            this.errorModal.selector.find(".modal-body-text").html(text);
            this.errorModal.show();
        }
    }

    update() {
        const dt = math.clamp(this.pixi!.ticker.elapsedMS / 1000, 0.001, 1 / 8);
        this.pingTest.update(dt);
        if (!this.checkedPingTest && this.pingTest.isComplete()) {
            if (!this.config.get("regionSelected")) {
                const region = resolveServerId(this.pingTest.getRegion());

                if (region) {
                    this.config.set("region", region);
                    this.setDOMFromConfig();
                }
            }
            this.checkedPingTest = true;
        }
        this.resourceManager!.update(dt);
        this.audioManager.update(dt);
        this.ambience.update(dt, this.audioManager, !this.active);

        // Game update
        if (this.game?.initialized && this.game.m_playing) {
            if (this.active) {
                this.setAppActive(false);
                this.setPlayLockout(true);
            }
            this.game.update(dt);
        }

        // LoadoutDisplay update
        if (this.active && this.loadoutDisplay && this.game && !this.game.initialized) {
            if (this.loadoutMenu.active) {
                if (!this.loadoutDisplay.initialized) {
                    this.loadoutDisplay.init();
                }
                this.loadoutDisplay.show();
                this.loadoutDisplay.update(dt, this.hasFocus);
            } else {
                this.loadoutDisplay.hide();
            }
        }
        if (!this.active && this.loadoutMenu.active) {
            this.loadoutMenu.hide();
        }
        if (this.active) {
            this.pass?.update(dt);
        }
        this.input!.flush();
    }
}

const App = new Application();

function onPageLoad() {
    App.domContentLoaded = true;
    App.tryLoad();
}

document.addEventListener("DOMContentLoaded", onPageLoad);
window.addEventListener("load", onPageLoad);
window.addEventListener("unload", (_e) => {
    App.onUnload();
});
if (window.location.hash == "#_=_") {
    window.location.hash = "";
    history.pushState("", document.title, window.location.pathname);
}
window.addEventListener("resize", () => {
    App.onResize();
});
window.addEventListener("orientationchange", () => {
    App.onResize();
});
window.addEventListener("hashchange", () => {
    const key = normalizeTeamRoomKey(window.location.hash);
    if (!key) return;
    if (Date.now() < teamHashJoin.suppressUntil) return;
    const teamMenu = App.teamMenu;
    if (teamMenu?.active && teamMenu.isWsLive()) {
        const current = normalizeTeamRoomKey(teamMenu.roomData.roomUrl || "");
        if (key === current) return;
    }
    App.tryJoinTeam(false);
});
window.addEventListener("beforeunload", (e) => {
    if (App.game?.canRejoinMatch()) {
        markMatchDisconnected();
    }
    if (App.game?.warnPageReload()) {
        // In new browsers, dialogText is overridden by a generic string
        const dialogText = "Do you want to reload the game?";
        e.returnValue = dialogText;
        return dialogText;
    }
});
window.addEventListener("focus", () => {
    App.hasFocus = true;
});
window.addEventListener("blur", () => {
    App.hasFocus = false;
});

const reportedErrors: string[] = [];
window.onerror = function(msg, url, lineNo, columnNo, error) {
    msg = msg || "undefined_error_msg";
    const stacktrace = error ? error.stack : "";

    // don't report useless errors lol
    if (!url || lineNo === undefined || columnNo === undefined) return;

    // ignore errors not generated by our code
    // and also weird errors that don't have a .js file
    if (!url.startsWith(location.href) || !/.js|.ts/.test(url)) return;

    // ignore scrappers
    if (/googlebot|bingbot|yandexbot|mediapartners-google/gi.test(navigator.userAgent)) return;

    const errObj = {
        msg,
        id: App.sessionId,
        url,
        line: lineNo,
        column: columnNo,
        stacktrace,
        browser: navigator.userAgent,
        protocol: GameConfig.protocolVersion,
        clientGitVersion: GIT_VERSION,
        serverGitVersion: App.siteInfo.info.gitRevision,
    };
    const errStr = JSON.stringify(errObj);

    // Don't report the same error multiple times
    if (!reportedErrors.includes(errStr)) {
        reportedErrors.push(errStr);
        errorLogManager.logWindowOnError(errObj);
    }
};
