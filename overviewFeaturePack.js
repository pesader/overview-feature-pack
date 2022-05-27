// Workspace Switcher Manager
// GPL v3 ©G-dH@Github.com
'use strict';

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const { AppMenu } = imports.ui.appMenu;
const PopupMenu = imports.ui.popupMenu;
const BoxPointer = imports.ui.boxpointer;
const Main = imports.ui.main;

const AppDisplay = imports.ui.appDisplay;
const Dash = imports.ui.dash;
const OverviewControls = imports.ui.overviewControls;
const WorkspacesView = imports.ui.workspacesView;
const WindowPreview = imports.ui.windowPreview;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Settings = Me.imports.settings;
const shellVersion = Settings.shellVersion;

const _Util = Me.imports.util;


let _appIconInjections = {};
let _windowPreviewInjections = {};
let _featurePackOverrides = {};
let _dashRedisplayTimeoutId = 0;

let gOptions;


function activate() {
    gOptions = new Settings.Options();

    if (Object.keys(_featurePackOverrides).length != 0)
        reset();

    _featurePackOverrides['WorkspacesDisplay'] = _Util.overrideProto(WorkspacesView.WorkspacesDisplay.prototype, WorkspacesDisplayOverride);
    _featurePackOverrides['AppIcon'] = _Util.overrideProto(AppDisplay.AppIcon.prototype, AppIconOverride);
    _injectAppIcon();
    _injectWindowPreview();
    _updateDash();

    Main.overview.connect('hiding', () => {
        if (global.windowToActivate) {
            global.windowToActivate.activate(global.get_current_time());
        }
    });
}

function reset() {
    if (!gOptions)
        return;

    for (let name in _appIconInjections) {
        _Util.removeInjection(AppDisplay.AppIcon.prototype, _appIconInjections, name);
    }
    _appIconInjections = {};

    for (let name in _windowPreviewInjections) {
        _Util.removeInjection(WindowPreview.WindowPreview.prototype, _windowPreviewInjections, name);
    }

    _Util.overrideProto(AppDisplay.AppIcon.prototype, _featurePackOverrides['AppIcon']);
    _Util.overrideProto(WorkspacesView.WorkspacesDisplay.prototype, _featurePackOverrides['WorkspacesDisplay']);
    _featurePackOverrides = {};

    const removeConnections = true;
    _updateDash(removeConnections);

    if (_dashRedisplayTimeoutId) {
        GLib.source_remove(_dashRedisplayTimeoutId);
        _dashRedisplayTimeoutId = 0;
    }
    gOptions.destroy();
    gOptions = null;
}

//----- AppIcon -----------------------------------------------------------------------

function _injectAppIcon() {
    _appIconInjections['_init'] = _Util.injectToFunction(
        AppDisplay.AppIcon.prototype, '_init', _connectAppIconScrollEnterLeave
    );
}

//----- WindowPreview ------------------------------------------------------------------

function _injectWindowPreview() {
    _windowPreviewInjections['_init'] = _Util.injectToFunction(
        WindowPreview.WindowPreview.prototype, '_init', function() {
            if (gOptions.get('moveTitlesIntoWindows'))
                this._title.get_constraints()[1].offset = - 1.3 * WindowPreview.ICON_SIZE;
        }
    );

    // activate window under the pointer even if you don't click on it
    _windowPreviewInjections['showOverlay'] = _Util.injectToFunction(
        WindowPreview.WindowPreview.prototype, 'showOverlay', function() {
            if (gOptions.get('hoverActivatesWindowOnLeave') && Main.overview._shown) {
                this._focusWindowSet = true;
                global.windowToActivate = this.metaWindow;
            }
        }
    );

    _windowPreviewInjections['hideOverlay'] = _Util.injectToFunction(
        WindowPreview.WindowPreview.prototype, 'hideOverlay', function() {
            if (gOptions.get('hoverActivatesWindowOnLeave') && this._focusWindowSet) {
                this._focusWindowSet = false;
                global.windowToActivate = null;
            }
        }
    );
}

function _moveDashAppGridIconLeft(reset = false) {
    // move dash app grid icon to the front
    const dash = Main.overview.dash;
    let target;
    if (reset)
        target = dash._showAppsIcon;
    else
        target = dash._box;
    const container = dash._dashContainer;
    container.remove_actor(target);
    container.add_actor(target);
}

function _updateDash(remove = false) {
    // destroying dash icons and redisplay has consequences - error nessages in log and placeholders whilde DND icons in Dash

    // sometimes Dash missing some icons, _redisplay can add them. But this executes too early after shell restarts so it has no effect here in this case
    //Main.overview.dash._redisplay();
    Main.overview.dash._box.get_children().forEach(c => {
        const appIcon = c.child;

        if (remove) {
            if (appIcon && appIcon._scrollConnectionID) {
                appIcon.disconnect(appIcon._scrollConnectionID);
                appIcon._scrollConnectionID = 0;
            }
            if (appIcon && appIcon._enterConnectionID) {
                appIcon.disconnect(appIcon._enterConnectionID);
                appIcon._enterConnectionID = 0;
            }
            if (appIcon && appIcon._leaveConnectionID) {
                appIcon.disconnect(appIcon._leaveConnectionID);
                appIcon._leaveConnectionID = 0;
            }
        } else if (appIcon && !appIcon._scrollConnectionID) {
            _connectAppIconScrollEnterLeave(null, null, appIcon);
        }
    });

    // After resetting the Shell, some running icons don't appear in Dash, _redisplay() helps
    _dashRedisplayTimeoutId =  GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        5000,
        () => {
            Main.overview.dash._redisplay();
            _dashRedisplayTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
    );
}

// WorkspacesDisplay
// add reorder workspace using Shift + (mouse wheel / PageUP/PageDown)

var WorkspacesDisplayOverride = {
    _onScrollEvent: function(actor, event) {
        if (this._swipeTracker.canHandleScrollEvent(event))
            return Clutter.EVENT_PROPAGATE;

        if (!this.mapped)
            return Clutter.EVENT_PROPAGATE;

        if (this._workspacesOnlyOnPrimary &&
            this._getMonitorIndexForEvent(event) != this._primaryIndex)
            return Clutter.EVENT_PROPAGATE;

        if (gOptions.get('addReorderWs') && global.get_pointer()[2] & Clutter.ModifierType.SHIFT_MASK) {
            let direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP) {
                direction = -1;
            }
            else if (direction === Clutter.ScrollDirection.DOWN) {
                direction = 1;
            } else {
                direction = 0;
            }

            if (direction) {
                _reorderWorkspace(direction);
                return Clutter.EVENT_STOP;
            }
        }

        return Main.wm.handleWorkspaceScroll(event);
    },

    _onKeyPressEvent: function(actor, event) {
        const { ControlsState } = OverviewControls;
        if (this._overviewAdjustment.value !== ControlsState.WINDOW_PICKER)
            return Clutter.EVENT_PROPAGATE;

        if (!this.reactive)
            return Clutter.EVENT_PROPAGATE;

        const { workspaceManager } = global;
        const vertical = workspaceManager.layout_rows === -1;
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;

        let which;
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Page_Up:
            if (vertical)
                which = Meta.MotionDirection.UP;
            else if (rtl)
                which = Meta.MotionDirection.RIGHT;
            else
                which = Meta.MotionDirection.LEFT;
            break;
        case Clutter.KEY_Page_Down:
            if (vertical)
                which = Meta.MotionDirection.DOWN;
            else if (rtl)
                which = Meta.MotionDirection.LEFT;
            else
                which = Meta.MotionDirection.RIGHT;
            break;
        case Clutter.KEY_Home:
            which = 0;
            break;
        case Clutter.KEY_End:
            which = workspaceManager.n_workspaces - 1;
            break;
        case Clutter.KEY_Tab:
        case Clutter.KEY_space:
            if (gOptions.get('spaceActivatesDash'))
                Main.ctrlAltTabManager._items.forEach(i => {if (i.sortGroup === 1 && i.name === 'Dash') Main.ctrlAltTabManager.focusGroup(i)});
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }

        let ws;
        if (which < 0)
            // Negative workspace numbers are directions
            // with respect to the current workspace
            ws = workspaceManager.get_active_workspace().get_neighbor(which);
        else
            // Otherwise it is a workspace index
            ws = workspaceManager.get_workspace_by_index(which);

        if (gOptions.get('addReorderWs') && event.get_state() & Clutter.ModifierType.SHIFT_MASK) {
            let direction;
            if (which === Meta.MotionDirection.UP || which === Meta.MotionDirection.LEFT)
                direction = -1;
            else if (which === Meta.MotionDirection.DOWN || which === Meta.MotionDirection.RIGHT)
                direction = 1;
            if (direction)
                _reorderWorkspace(direction);
                return Clutter.EVENT_STOP;
        }

        if (ws)
            Main.wm.actionMoveWorkspace(ws);

        return Clutter.EVENT_STOP;
    }
}

// AppIcon
var AppIconOverride = {
    activate: function(button) {
        let event = Clutter.get_current_event();
        let modifiers = event ? event.get_state() : 0;
        let isMiddleButton = button && button == Clutter.BUTTON_MIDDLE;
        let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
        let isShiftPressed = (modifiers & Clutter.ModifierType.SHIFT_MASK) != 0;
        let openNewWindow = this.app.can_open_new_window() &&
                            this.app.state == Shell.AppState.RUNNING &&
                            (isCtrlPressed || isMiddleButton);

        const currentWS = global.workspace_manager.get_active_workspace();
        const appRecentWorkspace = _getAppRecentWorkspace(this.app);
        
        let targetWindowOnCurrentWs = false;
        if (gOptions.get('dashClickFollowsRecentWindow')) {
            targetWindowOnCurrentWs = appRecentWorkspace === currentWS;
        } else {
            this.app.get_windows().forEach(
                w => targetWindowOnCurrentWs = targetWindowOnCurrentWs || (w.get_workspace() === currentWS)
            );
        }

        if ((this.app.state == Shell.AppState.STOPPED || openNewWindow) && !isShiftPressed)
            this.animateLaunch();

        if (openNewWindow) {
            this.app.open_new_window(-1);
        // if the app has more than one window (option: and has no window on the current workspace),
        // don't activate the app, only move the overview to the workspace with the app's recent window
        } else if (gOptions.get('dashShowWindowsBeforeActivation') && !isShiftPressed && this.app.get_n_windows() > 1 && !targetWindowOnCurrentWs) {
            this._scroll = true;
            this._scrollTime = new Date();
            //const appWS = this.app.get_windows()[0].get_workspace();
            Main.wm.actionMoveWorkspace(appRecentWorkspace);
            Main.overview.dash.showAppsButton.checked = false;
            return;
        } else if (gOptions.get('dashShiftClickMovesAppToCurrentWs') && isShiftPressed && this.app.get_windows().length) {
            this._moveAppToCurrentWorkspace();
            return;
        } else if (isShiftPressed) {
            return;
        } else {
            this.app.activate();
        }

        Main.overview.hide();
    },

    _moveAppToCurrentWorkspace: function() {
        this.app.get_windows().forEach(w => w.change_workspace(global.workspace_manager.get_active_workspace()));
    },

    popupMenu: function(side = St.Side.LEFT) {
        this.setForcedHighlight(true);
        this._removeMenuTimeout();
        this.fake_release();

        if (this._menu)
            this._menu.destroy();
        this._menu = null;

        if (!this._menu) {
            this._menu = new AppMenu(this, side, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this.app);
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            Main.overview.connectObject('hiding',
                () => this._menu.close(), this);

            Main.uiGroup.add_actor(this._menu.actor);
            this._menuManager.addMenu(this._menu);

            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const popupItems =[];
            if (this.app.get_n_windows()) {
                if (gOptions.get('appMenuForceQuit'))
                    popupItems.push([_('Force Quit'), () => this.app.get_windows()[0].kill()]);
                if (gOptions.get('appMenuMoveAppToWs'))
                    popupItems.push([_('Move App to Current Workspace'), this._moveAppToCurrentWorkspace]);
            }

             popupItems.forEach(i => {
                 let item = new PopupMenu.PopupMenuItem(i[0]);
                 this._menu.addMenuItem(item);
                 item.connect('activate', i[1].bind(this));
             });
        }

        this.emit('menu-state-changed', true);

        this._menu.open(BoxPointer.PopupAnimation.FULL);
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');

        return false;
    }
}

// --------------------------------------------------------------------------------------------------------------------
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

function _updateWorkspacesDisplay() {
    const { initialState, finalState, progress } = this._stateAdjustment.getStateTransitionParams();
    const { searchActive } = this._searchController;

    const paramsForState = s => {
        let opacity;
        switch (s) {
            case ControlsState.HIDDEN:
            case ControlsState.WINDOW_PICKER:
                opacity = 255;
                break;
            case ControlsState.APP_GRID:
                opacity = 0;
                break;
            default:
                opacity = 255;
                break;
        }
        return { opacity };
    };

    let initialParams = paramsForState(initialState);
    let finalParams = paramsForState(finalState);

    let opacity = Math.round(Util.lerp(initialParams.opacity, finalParams.opacity, progress));

    let workspacesDisplayVisible = (opacity != 0) && !(searchActive);
    let params = {
        opacity: opacity,
        duration: 0,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
            // workspacesDisplay needs to go from screen, otherwise it blocks DND operations within the App Display
            // but the 'visibile' property ruins transition animation and breakes workspace control
            // scale_y = 0 works same as visibile = 0 but without collateral damage
            this._workspacesDisplay.scale_y = (progress == 1 && finalState == ControlsState.APP_GRID) ? 0 : 1;
            this._workspacesDisplay.reactive = workspacesDisplayVisible;
            this._workspacesDisplay.setPrimaryWorkspaceVisible(workspacesDisplayVisible);
            // following changes in which axis will operate overshoot detection which switches appDisplay pages while dragging app icon to vertical
            // overall orientation of the grid and its pages stays horizontal, global orientation switch is not built-in
            if (finalState === ControlsState.APP_GRID)
                Main.overview._overview.controls._appDisplay._orientation = Clutter.Orientation.VERTICAL;
        }
    }

    // scale workspaces back to normal size before transition from AppGrid view
    if (progress < 1 && !this._workspacesDisplay.scale_y) {
        this._workspacesDisplay.scale_y = 1;
    }

    this._workspacesDisplay.ease(params);
}

function _reorderWorkspace(direction = 0) {
    let activeWs = global.workspace_manager.get_active_workspace();
    let activeWsIdx = activeWs.index();
    let targetIdx = activeWsIdx + direction;
    if (targetIdx > -1 && targetIdx < (global.workspace_manager.get_n_workspaces())) {
        global.workspace_manager.reorder_workspace(activeWs, targetIdx);
    }
}

// this function switches workspaces with windows of the scrolled app and lowers opacity of other windows in the overview to quickly find its windows
function _connectAppIconScrollEnterLeave(app, something, appIcon = null) {
    const _delegate = appIcon ? appIcon : this;

    _delegate._enterConnectionID = _delegate.connect('enter-event', () => _highlightMyWindows(_delegate, _delegate.app));
    _delegate._leaveConnectionID = _delegate.connect('leave-event', () => _highlightMyWindows(_delegate, _delegate.app, 255));
    _delegate._scrollConnectionID = _delegate.connect_after('scroll-event', (actor, event) => {

        if (!gOptions.get('dashScrollSwitchesAppWindowsWs'))
            return Clutter.EVENT_PROPAGATE;

        if (_delegate._scrollTime && (new Date() - _delegate._scrollTime) < 200) {
            return Clutter.EVENT_STOP;
        }

        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.DOWN) {
            _delegate._scroll = true;
            if (_delegate.app.get_n_windows()) {
                const appWorkspaces = [];
                _delegate.app.get_windows().forEach( w => {
                    const ws = w.get_workspace();
                    if (!appWorkspaces.includes(ws)) {
                        appWorkspaces.push(ws);
                    }
                });
                appWorkspaces.sort((a,b) => b.index() < a.index());
                let targetWsIdx;
                const currentWS = global.workspace_manager.get_active_workspace();
                const currIdx = appWorkspaces.indexOf(currentWS);
                if (direction === Clutter.ScrollDirection.UP) {
                    targetWsIdx = (currIdx + appWorkspaces.length - 1) % appWorkspaces.length;
                } else {
                    targetWsIdx = (currIdx + 1) % appWorkspaces.length;
                }

                //const appWS = _delegate.app.get_windows()[0].get_workspace();
                Main.wm.actionMoveWorkspace(appWorkspaces[targetWsIdx]);
                Main.overview.dash.showAppsButton.checked = false;
                _delegate._scrollTime = new Date();

                // dimm windows of other apps
                _highlightMyWindows(_delegate, _delegate.app);
            }
            return Clutter.EVENT_STOP;
        }
        // activate app's workspace
        // and hide windows of other apps
    });
}

function _highlightMyWindows (delegate, app, othersOpacity = 50) {
    if (!gOptions.get('dashHoverIconHighlitsWindows'))
        return;

    const _delegate = delegate;
    let onlyShowTitles = false;
    if (othersOpacity === 255) {
        // even if the mouse pointer is still above the app icon, the 'leave' signals are emited during switching workspace
        // this timeout should prevent unwanted calls
        if (_delegate._scrollTime && (new Date() - _delegate._scrollTime) < 200) {
            return;
        }
        _delegate._scroll = false;
    } else if (!_delegate._scroll) {
        onlyShowTitles = true;
    }

    const currentWS = global.workspace_manager.get_active_workspace();
    let lastUsedWinForWs = null;
    app.get_windows().forEach(w => {
        if (!lastUsedWinForWs && w.get_workspace() === currentWS) {
            lastUsedWinForWs = w;
        }
    });
    const appRecentWorkspace = _getAppRecentWorkspace(app);
    const appLastUsedWindow = _getAppLastUsedWindow(app);
    
    const views = Main.overview._overview.controls._workspacesDisplay._workspacesViews;
    const viewsIter = [views[0]];
    // socondary monitors use different structure
    views.forEach(v => {
        if (v._workspacesView)
            viewsIter.push(v._workspacesView)
    });

    viewsIter.forEach(view => {
        // if workspaces on primary monitor only
        if (!view || !view._workspaces)
            return;

        view._workspaces.forEach(ws => {
            ws._windows.forEach(windowPreview => {
                try {
                    windowPreview._title.opacity;
                } catch {
                    return;
                }

                let opacity, titleOpacity;
                if (app.get_windows().includes(windowPreview.metaWindow)) {
                    opacity = 255;
                    titleOpacity = othersOpacity === 255 ? 0 : 255;
                    if (windowPreview.metaWindow === appLastUsedWindow) {
                        windowPreview._closeButton.show();
                        windowPreview._closeButton.opacity = 255;
                        windowPreview._closeButton.set_style('background-color: green');
                    }
                } else {
                    opacity = othersOpacity;
                    titleOpacity = 0;
                }

                // If we're supposed to animate and an animation in our direction
                // is already happening, let that one continue
                const ongoingTransition = windowPreview._title.get_transition('opacity');
                if (!(ongoingTransition &&
                    ongoingTransition.get_interval().peek_final_value() === titleOpacity)) {
                        windowPreview._title.ease({
                            opacity: titleOpacity,
                            duration: WindowPreview.WINDOW_OVERLAY_FADE_TIME,
                            onComplete: () => {
                                if (titleOpacity === 0) {
                                    windowPreview._title.hide();
                                    windowPreview._closeButton.opacity = 0;
                                } else {
                                    windowPreview._title.show();
                                }
                            }
                        });
                    }


                if (onlyShowTitles)
                    return;

                windowPreview.ease({
                    opacity: opacity,
                    duration: WindowPreview.WINDOW_OVERLAY_FADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            });
        });
    });
}

function _getWindowApp(metaWin) {
    const tracker = Shell.WindowTracker.get_default();
    return tracker.get_window_app(metaWin);
}

function _getAppLastUsedWindow(app) {
    let recentWin;
    global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null).forEach(metaWin => {
        const winApp = _getWindowApp(metaWin);
        if (!recentWin && winApp == app) {
            recentWin = metaWin;
        }
    });
    return recentWin;
}

function _getAppRecentWorkspace(app) {
    const recentWin = _getAppLastUsedWindow(app)
    if (recentWin)
        return recentWin.get_workspace();

    return null;
}