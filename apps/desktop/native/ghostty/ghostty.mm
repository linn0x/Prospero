#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
#include <ghostty.h>
#include <string>
#include <unordered_map>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>

// This module runs exclusively on Electron's AppKit/main thread. JavaScript
// owns the daemon connection; Ghostty owns only its view and relay child PTY.
static ghostty_app_t app = nullptr;
static ghostty_config_t config = nullptr;
static uint32_t nextId = 1;
struct NapiCallback {
  napi_env env = nullptr;
  napi_ref function = nullptr;
  napi_ref resource = nullptr;
  napi_async_context asyncContext = nullptr;
};
static NapiCallback shortcutCallback;
static NapiCallback focusCallback;
static NapiCallback imagePasteCallback;

static bool setCallback(NapiCallback *callback, napi_env env, napi_value function) {
  if (callback->asyncContext) napi_async_destroy(callback->env, callback->asyncContext);
  if (callback->function) napi_delete_reference(callback->env, callback->function);
  if (callback->resource) napi_delete_reference(callback->env, callback->resource);
  *callback = {};
  napi_valuetype type;
  if (napi_typeof(env, function, &type) != napi_ok) return false;
  if (type == napi_null || type == napi_undefined) return true;
  if (type != napi_function) return false;
  napi_value global, name;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_create_string_utf8(env, "ProsperoNativeGhostty", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_async_init(env, global, name, &callback->asyncContext) != napi_ok ||
      napi_create_reference(env, function, 1, &callback->function) != napi_ok ||
      napi_create_reference(env, global, 1, &callback->resource) != napi_ok) {
    if (callback->asyncContext) napi_async_destroy(env, callback->asyncContext);
    if (callback->function) napi_delete_reference(env, callback->function);
    if (callback->resource) napi_delete_reference(env, callback->resource);
    *callback = {};
    return false;
  }
  callback->env = env;
  return true;
}

static napi_status callCallback(NapiCallback *callback,
                                size_t argc,
                                const napi_value *argv,
                                napi_value *result) {
  if (!callback->function || !callback->asyncContext) return napi_invalid_arg;
  napi_value resource, function;
  napi_status status = napi_get_reference_value(callback->env, callback->resource, &resource);
  if (status == napi_ok) status = napi_get_reference_value(callback->env, callback->function, &function);
  napi_callback_scope callbackScope = nullptr;
  if (status == napi_ok) status = napi_open_callback_scope(callback->env, resource, callback->asyncContext, &callbackScope);
  if (status == napi_ok) status = napi_make_callback(callback->env, callback->asyncContext, resource, function, argc, argv, result);
  if (callbackScope) napi_close_callback_scope(callback->env, callbackScope);
  return status;
}

static ghostty_input_mods_e mods(NSEventModifierFlags f) {
  return (ghostty_input_mods_e)((f & NSEventModifierFlagShift ? GHOSTTY_MODS_SHIFT : 0) |
    (f & NSEventModifierFlagControl ? GHOSTTY_MODS_CTRL : 0) |
    (f & NSEventModifierFlagOption ? GHOSTTY_MODS_ALT : 0) |
    (f & NSEventModifierFlagCommand ? GHOSTTY_MODS_SUPER : 0) |
    (f & NSEventModifierFlagCapsLock ? GHOSTTY_MODS_CAPS : 0));
}

static constexpr ghostty_input_mouse_momentum_e scrollMomentum(NSEventPhase phase) {
  // NSEventPhase is an OptionSet (bit flags), while Ghostty's packed momentum
  // field is a sequential enum. Map phases exactly as the pinned Swift frontend.
  switch (phase) {
    case NSEventPhaseBegan: return GHOSTTY_MOUSE_MOMENTUM_BEGAN;
    case NSEventPhaseStationary: return GHOSTTY_MOUSE_MOMENTUM_STATIONARY;
    case NSEventPhaseChanged: return GHOSTTY_MOUSE_MOMENTUM_CHANGED;
    case NSEventPhaseEnded: return GHOSTTY_MOUSE_MOMENTUM_ENDED;
    case NSEventPhaseCancelled: return GHOSTTY_MOUSE_MOMENTUM_CANCELLED;
    case NSEventPhaseMayBegin: return GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN;
    default: return GHOSTTY_MOUSE_MOMENTUM_NONE;
  }
}
static_assert(scrollMomentum(NSEventPhaseBegan) == GHOSTTY_MOUSE_MOMENTUM_BEGAN);
static_assert(scrollMomentum(NSEventPhaseStationary) == GHOSTTY_MOUSE_MOMENTUM_STATIONARY);
static_assert(scrollMomentum(NSEventPhaseChanged) == GHOSTTY_MOUSE_MOMENTUM_CHANGED);
static_assert(scrollMomentum(NSEventPhaseEnded) == GHOSTTY_MOUSE_MOMENTUM_ENDED);
static_assert(scrollMomentum(NSEventPhaseCancelled) == GHOSTTY_MOUSE_MOMENTUM_CANCELLED);
static_assert(scrollMomentum(NSEventPhaseMayBegin) == GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN);

@interface ProsperoPendingClipboard : NSObject
@property(nonatomic, assign) ghostty_surface_t surface;
@property(nonatomic, assign) void *state;
@property(nonatomic, strong) NSString *text;
@property(nonatomic, strong) NSAlert *alert;
@property(nonatomic, assign) BOOL active;
@end
@implementation ProsperoPendingClipboard
@end

@interface ProsperoGhosttyView : NSView<NSTextInputClient>
@property(nonatomic, assign) ghostty_surface_t surface;
@property(nonatomic, assign) uint32_t surfaceId;
@property(nonatomic, assign) BOOL readOnly;
@property(nonatomic, assign) BOOL ghosttyFocused;
@property(nonatomic, assign) NSUInteger mouseFocusGeneration;
@property(nonatomic, assign) BOOL pendingMouseFocus;
@property(nonatomic, assign) BOOL wantsNativeFocusAfterActivation;
@property(nonatomic, assign) BOOL activationLossPending;
@property(nonatomic, assign) BOOL mouseWindowIsKey;
@property(nonatomic, assign) BOOL mouseAppIsActive;
@property(nonatomic, weak) NSWindow *mouseFocusWindow;
@property(nonatomic, strong) id mouseWindowKeyObserver;
@property(nonatomic, strong) id mouseWindowResignObserver;
@property(nonatomic, strong) id mouseAppActiveObserver;
@property(nonatomic, strong) id mouseAppResignObserver;
@property(nonatomic, strong) id displayObserver;
@property(nonatomic, strong) NSMutableAttributedString *marked;
@property(nonatomic, strong) NSMutableString *keyText;
@property(nonatomic, strong) NSMutableArray<ProsperoPendingClipboard *> *pendingClipboardConfirmations;
@property(nonatomic, strong) NSTrackingArea *tracking;
@end
static void notifyFocus(ProsperoGhosttyView *, bool);
static bool notifyImagePaste(ProsperoGhosttyView *);
@interface ProsperoGhosttyView ()
- (void)updateDisplayID;
@end

@implementation ProsperoGhosttyView
- (instancetype)initWithFrame:(NSRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.wantsLayer = YES;
    self.marked = [[NSMutableAttributedString alloc] initWithString:@""];
    self.pendingClipboardConfirmations = [[NSMutableArray alloc] init];
    self.accessibilityElement = YES;
    self.accessibilityRole = NSAccessibilityTextAreaRole;
    self.accessibilityLabel = @"Terminal";
    self.accessibilityRoleDescription = @"Terminal text";
  }
  return self;
}
- (BOOL)isFlipped { return YES; }
- (void)dealloc { [self removeMouseFocusObservers]; }
- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  [self removeMouseFocusObservers];
  NSWindow *window = self.window;
  if (!window) return;
  [self updateDisplayID];
  self.mouseFocusWindow = window;
  self.mouseWindowIsKey = window.isKeyWindow;
  self.mouseAppIsActive = NSApp.isActive;
  __weak ProsperoGhosttyView *weakSelf = self;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  self.displayObserver = [center addObserverForName:NSWindowDidChangeScreenNotification object:window queue:nil usingBlock:^(NSNotification *notification) {
    ProsperoGhosttyView *view = weakSelf;
    if (!view || notification.object != view.window) return;
    [view updateDisplayID];
  }];
  self.mouseWindowResignObserver = [center addObserverForName:NSWindowDidResignKeyNotification object:window queue:nil usingBlock:^(NSNotification *) {
    ProsperoGhosttyView *view = weakSelf;
    if (!view) return;
    if (window.firstResponder == view || view.ghosttyFocused || view.pendingMouseFocus) {
      view.wantsNativeFocusAfterActivation = YES;
      view.activationLossPending = YES;
    }
    view.mouseWindowIsKey = NO;
  }];
  self.mouseWindowKeyObserver = [center addObserverForName:NSWindowDidBecomeKeyNotification object:window queue:nil usingBlock:^(NSNotification *) {
    ProsperoGhosttyView *view = weakSelf;
    if (!view) return;
    view.mouseWindowIsKey = YES;
    if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] window became key id=%u restore=%d pending=%d generation=%lu\n", view.surfaceId, view.wantsNativeFocusAfterActivation, view.pendingMouseFocus, (unsigned long)view.mouseFocusGeneration);
    [view scheduleMouseFocusRestore];
  }];
  self.mouseAppResignObserver = [center addObserverForName:NSApplicationWillResignActiveNotification object:NSApp queue:nil usingBlock:^(NSNotification *) {
    ProsperoGhosttyView *view = weakSelf;
    if (!view) return;
    if (window.firstResponder == view || view.ghosttyFocused || view.pendingMouseFocus) {
      view.wantsNativeFocusAfterActivation = YES;
      view.activationLossPending = YES;
    }
    view.mouseAppIsActive = NO;
  }];
  self.mouseAppActiveObserver = [center addObserverForName:NSApplicationDidBecomeActiveNotification object:NSApp queue:nil usingBlock:^(NSNotification *) {
    ProsperoGhosttyView *view = weakSelf;
    if (!view) return;
    view.mouseAppIsActive = YES;
    if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] app became active id=%u restore=%d pending=%d generation=%lu\n", view.surfaceId, view.wantsNativeFocusAfterActivation, view.pendingMouseFocus, (unsigned long)view.mouseFocusGeneration);
    [view scheduleMouseFocusRestore];
  }];
}
- (void)updateDisplayID {
  if (!_surface || !self.window) return;
  NSScreen *screen = self.window.screen;
  NSNumber *displayNumber = screen.deviceDescription[@"NSScreenNumber"];
  if (!screen || !displayNumber) return;
  ghostty_surface_set_display_id(_surface, displayNumber.unsignedIntValue);
}
- (BOOL)acceptsFirstResponder { return YES; }
- (void)removeMouseFocusObservers {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  if (_displayObserver) [center removeObserver:_displayObserver];
  if (_mouseWindowKeyObserver) [center removeObserver:_mouseWindowKeyObserver];
  if (_mouseWindowResignObserver) [center removeObserver:_mouseWindowResignObserver];
  if (_mouseAppActiveObserver) [center removeObserver:_mouseAppActiveObserver];
  if (_mouseAppResignObserver) [center removeObserver:_mouseAppResignObserver];
  self.mouseWindowKeyObserver = nil;
  self.mouseWindowResignObserver = nil;
  self.mouseAppActiveObserver = nil;
  self.mouseAppResignObserver = nil;
  self.displayObserver = nil;
}
- (void)cancelPendingMouseFocus {
  self.pendingMouseFocus = NO;
  self.mouseFocusGeneration++;
}
- (void)cancelNativeActivationFocus {
  self.wantsNativeFocusAfterActivation = NO;
  self.activationLossPending = NO;
  [self cancelPendingMouseFocus];
}
- (void)scheduleMouseFocusRestore {
  if ((!self.pendingMouseFocus && !self.wantsNativeFocusAfterActivation) || !self.mouseWindowIsKey || !self.mouseAppIsActive) return;
  NSUInteger generation = self.mouseFocusGeneration;
  __weak ProsperoGhosttyView *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    ProsperoGhosttyView *view = weakSelf;
    if (!view || (!view.pendingMouseFocus && !view.wantsNativeFocusAfterActivation) || view.mouseFocusGeneration != generation) return;
    NSWindow *window = view.window;
    if (!view.surface || !window || window != view.mouseFocusWindow || view.hidden ||
        [view isHiddenOrHasHiddenAncestor] || !window.isVisible || window.attachedSheet || NSApp.modalWindow) {
      if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] activation refocus rejected id=%u generation=%lu hidden=%d ancestorHidden=%d visible=%d sheet=%d modal=%d\n",
        view.surfaceId, (unsigned long)generation, view.hidden, [view isHiddenOrHasHiddenAncestor],
        window.isVisible, window.attachedSheet != nil, NSApp.modalWindow != nil);
      [view cancelNativeActivationFocus];
      return;
    }
    NSEvent *current = NSApp.currentEvent;
    if (view.wantsNativeFocusAfterActivation && current &&
        (current.type == NSEventTypeLeftMouseDown || current.type == NSEventTypeRightMouseDown) &&
        current.windowNumber == window.windowNumber) {
      NSPoint screenPoint = NSEvent.mouseLocation;
      NSPoint windowPoint = [window convertPointFromScreen:screenPoint];
      NSPoint viewPoint = [view convertPoint:windowPoint fromView:nil];
      if (!NSPointInRect(viewPoint, view.bounds)) {
        if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] activation restore canceled by outside click id=%u\n", view.surfaceId);
        [view cancelNativeActivationFocus];
        return;
      }
    }
    view.pendingMouseFocus = NO;
    view.wantsNativeFocusAfterActivation = NO;
    view.activationLossPending = NO;
    if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] activation refocus id=%u responder=%s\n",
      view.surfaceId, window.firstResponder ? object_getClassName(window.firstResponder) : "nil");
    if (window.firstResponder != view) [window makeFirstResponder:view];
    view.wantsNativeFocusAfterActivation = YES;
  });
}
- (void)beginMouseFocusForWindow:(NSWindow *)window {
  self.pendingMouseFocus = YES;
  self.mouseFocusWindow = window;
  self.mouseWindowIsKey = window.isKeyWindow;
  self.mouseAppIsActive = NSApp.isActive;
  [self scheduleMouseFocusRestore];
}
- (BOOL)becomeFirstResponder {
  self.ghosttyFocused = YES;
  self.wantsNativeFocusAfterActivation = YES;
  if (_surface) ghostty_surface_set_focus(_surface, true);
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] becomeFirstResponder id=%u\n", self.surfaceId);
  NSAccessibilityPostNotification(self, NSAccessibilityFocusedUIElementChangedNotification);
  notifyFocus(self, true);
  return YES;
}
- (BOOL)resignFirstResponder {
  self.ghosttyFocused = NO;
  BOOL activationBlur = self.activationLossPending || self.pendingMouseFocus ||
    !self.window.isKeyWindow || !NSApp.isActive;
  if (activationBlur) self.wantsNativeFocusAfterActivation = YES;
  else [self cancelNativeActivationFocus];
  if (_surface) ghostty_surface_set_focus(_surface, false);
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) {
    fprintf(stderr, "[native-ghostty] resignFirstResponder id=%u\n", self.surfaceId);
    for (NSString *symbol in NSThread.callStackSymbols) fprintf(stderr, "  %s\n", symbol.UTF8String ?: "");
  }
  NSAccessibilityPostNotification(self, NSAccessibilityFocusedUIElementChangedNotification);
  notifyFocus(self, false);
  return YES;
}
- (BOOL)isAccessibilityFocused { return self.window.firstResponder == self; }
- (void)setAccessibilityFocused:(BOOL)focused {
  if (!self.window) return;
  if (focused) [self.window makeFirstResponder:self];
  else if (self.window.firstResponder == self) [self.window makeFirstResponder:self.superview];
}
- (id)accessibilityValue {
  if (!_surface) return @"";
  ghostty_selection_s selection = {};
  selection.top_left.tag = GHOSTTY_POINT_VIEWPORT;
  selection.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT;
  selection.bottom_right.tag = GHOSTTY_POINT_VIEWPORT;
  selection.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_text(_surface, selection, &text)) return @"";
  NSString *value = [[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding] ?: @"";
  ghostty_surface_free_text(_surface, &text);
  return value;
}
- (void)syncSize {
  if (!_surface || !self.window) return;
  double scale = self.window.backingScaleFactor;
  ghostty_surface_set_content_scale(_surface, scale, scale);
  ghostty_surface_set_size(_surface, (uint32_t)(self.bounds.size.width * scale), (uint32_t)(self.bounds.size.height * scale));
}
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self syncSize]; }
- (void)viewDidChangeBackingProperties { [self syncSize]; }
- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (_tracking) [self removeTrackingArea:_tracking];
  self.tracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect owner:self userInfo:nil];
  [self addTrackingArea:_tracking];
}
- (void)mouseEntered:(NSEvent *)e {
  [super mouseEntered:e];
  [self mouseMoved:e];
}
- (void)mouseExited:(NSEvent *)e {
  [super mouseExited:e];
  if (!_surface || NSEvent.pressedMouseButtons != 0) return;
  ghostty_surface_mouse_pos(_surface, -1, -1, mods(e.modifierFlags));
}
- (void)mouseMoved:(NSEvent *)e {
  if (!_surface) return;
  NSPoint p = [self convertPoint:e.locationInWindow fromView:nil];
  // This view is flipped, so AppKit has already converted the mouse position
  // to Ghostty's top-left origin. The upstream non-flipped view must invert Y.
  ghostty_surface_mouse_pos(_surface, p.x, p.y, mods(e.modifierFlags));
}
- (void)mouseDragged:(NSEvent *)e { [self mouseMoved:e]; }
- (void)rightMouseDragged:(NSEvent *)e { [self mouseMoved:e]; }
- (void)mouseDown:(NSEvent *)e {
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) {
    fprintf(stderr, "[native-ghostty] mouseDown id=%u firstResponder=%s window=%d frame={%.1f,%.1f,%.1f,%.1f}\n",
      self.surfaceId,
      self.window.firstResponder ? object_getClassName(self.window.firstResponder) : "nil",
      self.window != nil,
      self.frame.origin.x, self.frame.origin.y, self.frame.size.width, self.frame.size.height);
  }
  NSWindow *eventWindow = self.window;
  self.mouseFocusGeneration++;
  [self beginMouseFocusForWindow:eventWindow];
  [eventWindow makeFirstResponder:self]; [self mouseMoved:e];
  // Electron can restore WebContents as first responder during the later key
  // window/app activation notifications. Wait for both notifications before
  // scheduling focus restoration so the AppKit activation observers finish.
  if (_surface) ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods(e.modifierFlags));
}
- (void)mouseUp:(NSEvent *)e { if (_surface) ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods(e.modifierFlags)); }
- (void)rightMouseDown:(NSEvent *)e {
  [self.window makeFirstResponder:self];
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Terminal"];
  NSMenuItem *copy = [menu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@""];
  copy.target = self; copy.enabled = _surface && ghostty_surface_has_selection(_surface);
  NSMenuItem *paste = [menu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@""];
  paste.target = self; paste.enabled = !_readOnly;
  [NSMenu popUpContextMenu:menu withEvent:e forView:self];
}
- (void)scrollWheel:(NSEvent *)e {
  if (!_surface) return;
  double x = e.scrollingDeltaX, y = e.scrollingDeltaY;
  BOOL precise = e.hasPreciseScrollingDeltas;
  if (precise) { x *= 2; y *= 2; }
  // Ghostty packs precision into bit zero and its sequential momentum enum
  // into bits 1-3. NSEventPhase uses unrelated bit-flag values.
  int scrollMods = (precise ? 1 : 0) | ((int)scrollMomentum(e.momentumPhase) << 1);
  ghostty_surface_mouse_scroll(_surface, x, y, scrollMods);
}
- (void)copy:(id)sender { if (_surface) ghostty_surface_binding_action(_surface, "copy_to_clipboard", 17); }
- (void)paste:(id)sender {
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] paste action id=%u readonly=%d firstResponder=%d\n", self.surfaceId, self.readOnly, self.window.firstResponder == self);
  if (!_surface || _readOnly) return;
  NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
  BOOL hasImage = [pasteboard canReadObjectForClasses:@[NSImage.class] options:@{}];
  if (hasImage && notifyImagePaste(self)) return;
  ghostty_surface_binding_action(_surface, "paste_from_clipboard", 20);
}
- (BOOL)performKeyEquivalent:(NSEvent *)e {
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] performKeyEquivalent id=%u key=%s firstResponder=%d\n", self.surfaceId, e.charactersIgnoringModifiers.UTF8String ?: "", self.window.firstResponder == self);
  if (self.window.firstResponder != self || !_surface) return NO;
  if ((e.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask) == NSEventModifierFlagCommand) {
    if ([e.charactersIgnoringModifiers isEqualToString:@"c"]) { [self copy:nil]; return YES; }
    if ([e.charactersIgnoringModifiers isEqualToString:@"v"]) { [self paste:nil]; return YES; }
    if ([e.charactersIgnoringModifiers isEqualToString:@"a"]) { ghostty_surface_binding_action(_surface, "select_all", 10); return YES; }
  }
  NSEventModifierFlags flags = e.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
  NSString *key = e.charactersIgnoringModifiers.lowercaseString;
  const char *shortcut = nullptr;
  if (key.length == 1 && [key isEqualToString:@"f"]) {
    if (flags == (NSEventModifierFlagCommand | NSEventModifierFlagOption)) shortcut = "toggle-focus";
    else if (flags == (NSEventModifierFlagCommand | NSEventModifierFlagShift)) shortcut = "project-search";
    else if (flags == NSEventModifierFlagCommand) shortcut = "terminal-search";
  }
  if (shortcut) {
    if (shortcutCallback.function) {
      napi_value args[2], result;
      napi_handle_scope handleScope;
      if (napi_open_handle_scope(shortcutCallback.env, &handleScope) == napi_ok) {
        if (napi_create_string_utf8(shortcutCallback.env, shortcut, NAPI_AUTO_LENGTH, &args[0]) == napi_ok &&
            napi_create_uint32(shortcutCallback.env, self.surfaceId, &args[1]) == napi_ok) {
          callCallback(&shortcutCallback, 2, args, &result);
        }
        napi_close_handle_scope(shortcutCallback.env, handleScope);
      }
    }
    return YES;
  }
  // App shortcuts remain with Electron's menu/renderer, never the child PTY.
  return NO;
}
- (void)keyDown:(NSEvent *)e {
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] keyDown id=%u readonly=%d focused=%d\n", self.surfaceId, self.readOnly, self.window.firstResponder == self);
  if (!_surface || _readOnly) return;
  BOOL wasComposing = self.hasMarkedText;
  self.keyText = [[NSMutableString alloc] init];
  [self interpretKeyEvents:@[e]];
  ghostty_input_key_s key = {};
  key.action = e.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  key.keycode = e.keyCode;
  key.mods = mods(e.modifierFlags);
  key.consumed_mods = (ghostty_input_mods_e)(key.mods & (GHOSTTY_MODS_SHIFT | GHOSTTY_MODS_ALT));
  // Text accumulated by NSTextInputClient is a committed character. Only a
  // key that changed/cancelled preedit without committing text is composing.
  key.composing = self.keyText.length == 0 && (self.hasMarkedText || wasComposing);
  NSString *plain = [e charactersByApplyingModifiers:0];
  if (plain.length) {
    unichar first = [plain characterAtIndex:0];
    if (CFStringIsSurrogateHighCharacter(first) && plain.length > 1) {
      unichar second = [plain characterAtIndex:1];
      if (CFStringIsSurrogateLowCharacter(second)) key.unshifted_codepoint = CFStringGetLongCharacterForSurrogatePair(first, second);
    } else {
      key.unshifted_codepoint = first;
    }
  }
  const char *text = self.keyText.UTF8String;
  key.text = self.keyText.length && text && (uint8_t)text[0] >= 0x20 ? text : nullptr;
  ghostty_surface_key(_surface, key);
  self.keyText = nil;
}
- (void)keyUp:(NSEvent *)e {
  if (!_surface || _readOnly) return;
  ghostty_input_key_s key = {}; key.action = GHOSTTY_ACTION_RELEASE; key.keycode = e.keyCode; key.mods = mods(e.modifierFlags);
  ghostty_surface_key(_surface, key);
}
- (void)flagsChanged:(NSEvent *)e {
  if (!_surface || _readOnly || self.hasMarkedText) return;
  ghostty_input_mods_e modifier = GHOSTTY_MODS_NONE;
  switch (e.keyCode) {
    case 0x39: modifier = GHOSTTY_MODS_CAPS; break;
    case 0x38: case 0x3C: modifier = GHOSTTY_MODS_SHIFT; break;
    case 0x3B: case 0x3E: modifier = GHOSTTY_MODS_CTRL; break;
    case 0x3A: case 0x3D: modifier = GHOSTTY_MODS_ALT; break;
    case 0x37: case 0x36: modifier = GHOSTTY_MODS_SUPER; break;
    default: return;
  }
  ghostty_input_key_s key = {};
  key.action = (mods(e.modifierFlags) & modifier) ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE;
  key.keycode = e.keyCode;
  key.mods = mods(e.modifierFlags);
  ghostty_surface_key(_surface, key);
}
- (void)insertText:(id)value replacementRange:(NSRange)range {
  if (_readOnly) return;
  NSString *s = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
  [self unmarkText];
  if (_keyText) [_keyText appendString:s];
  else if (_surface) ghostty_surface_text(_surface, s.UTF8String, [s lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selected replacementRange:(NSRange)replacement {
  if (_readOnly) return;
  NSString *s = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
  self.marked = [[NSMutableAttributedString alloc] initWithString:s];
  if (_surface) ghostty_surface_preedit(_surface, s.UTF8String, [s lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
}
- (void)unmarkText { [self.marked setAttributedString:[[NSAttributedString alloc] initWithString:@""]]; if (_surface) ghostty_surface_preedit(_surface, nullptr, 0); }
- (BOOL)hasMarkedText { return self.marked.length > 0; }
- (NSRange)markedRange { return self.hasMarkedText ? NSMakeRange(0, self.marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return NSMakeRange(NSNotFound, 0); }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)r actualRange:(NSRangePointer)actual { if (actual) *actual = NSMakeRange(NSNotFound, 0); return nil; }
- (NSUInteger)characterIndexForPoint:(NSPoint)p { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)r actualRange:(NSRangePointer)actual {
  double x = 0, y = 0, w = 1, h = 16;
  if (_surface) ghostty_surface_ime_point(_surface, &x, &y, &w, &h);
  if (actual) *actual = self.markedRange;
  return [self.window convertRectToScreen:[self convertRect:NSMakeRect(x, y, w, h) toView:nil]];
}
- (void)doCommandBySelector:(SEL)selector { /* Ghostty encodes non-text keys. */ }
@end

static NSMutableDictionary<NSNumber *, ProsperoGhosttyView *> *views;
static void wakeup(void *) { dispatch_async(dispatch_get_main_queue(), ^{ if (app) ghostty_app_tick(app); }); }
static void notifyFocus(ProsperoGhosttyView *view, bool focused) {
  if (!focusCallback.function) return;
  napi_handle_scope handleScope;
  if (napi_open_handle_scope(focusCallback.env, &handleScope) != napi_ok) return;
  napi_value args[2], result;
  if (napi_create_uint32(focusCallback.env, view.surfaceId, &args[0]) == napi_ok &&
      napi_get_boolean(focusCallback.env, focused, &args[1]) == napi_ok) {
    callCallback(&focusCallback, 2, args, &result);
  }
  napi_close_handle_scope(focusCallback.env, handleScope);
}
static bool notifyImagePaste(ProsperoGhosttyView *view) {
  if (!imagePasteCallback.function) return false;
  napi_handle_scope handleScope;
  if (napi_open_handle_scope(imagePasteCallback.env, &handleScope) != napi_ok) return false;
  napi_value arg, result; bool handled = false;
  napi_status status = napi_create_uint32(imagePasteCallback.env, view.surfaceId, &arg);
  if (status == napi_ok) status = callCallback(&imagePasteCallback, 1, &arg, &result);
  if (status == napi_ok) status = napi_get_value_bool(imagePasteCallback.env, result, &handled);
  napi_close_handle_scope(imagePasteCallback.env, handleScope);
  if (status != napi_ok) return false;
  return handled;
}
static bool action(ghostty_app_t, ghostty_target_s, ghostty_action_s) { return false; }
static uint64_t clipboardReadCount = 0;
static bool readClipboard(void *userdata, ghostty_clipboard_e location, void *state) {
  ProsperoGhosttyView *view = (__bridge ProsperoGhosttyView *)userdata;
  NSString *text = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] ?: @"";
  clipboardReadCount++;
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] clipboard read id=%u count=%llu location=%d bytes=%lu\n",
    view.surfaceId, (unsigned long long)clipboardReadCount, (int)location,
    (unsigned long)[text lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
  ghostty_surface_complete_clipboard_request(view.surface, text.UTF8String, state, false);
  return true;
}
static void finishPendingClipboard(ProsperoGhosttyView *view,
                                   ProsperoPendingClipboard *pending,
                                   bool accept) {
  if (!pending.active) return;
  pending.active = NO;
  [view.pendingClipboardConfirmations removeObjectIdenticalTo:pending];
  if (view.surface == pending.surface && view.surface) {
    const char *contents = accept ? pending.text.UTF8String : "";
    ghostty_surface_complete_clipboard_request(view.surface, contents, pending.state, true);
  }
}
static void cancelPendingClipboardConfirmations(ProsperoGhosttyView *view) {
  for (ProsperoPendingClipboard *pending in [view.pendingClipboardConfirmations copy]) {
    if (!pending.active) continue;
    pending.active = NO;
    [view.pendingClipboardConfirmations removeObjectIdenticalTo:pending];
    if (view.surface == pending.surface && view.surface) {
      ghostty_surface_complete_clipboard_request(view.surface, "", pending.state, true);
    }
    [pending.alert.window close];
  }
}
static void confirmClipboard(void *userdata, const char *text, void *state, ghostty_clipboard_request_e request) {
  ProsperoGhosttyView *view = (__bridge ProsperoGhosttyView *)userdata;
  if (request != GHOSTTY_CLIPBOARD_REQUEST_PASTE || !view.window) {
    if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] deny clipboard confirmation id=%u request=%d\n", view.surfaceId, (int)request);
    ghostty_surface_complete_clipboard_request(view.surface, "", state, true);
    return;
  }

  ProsperoPendingClipboard *pending = [[ProsperoPendingClipboard alloc] init];
  pending.surface = view.surface;
  pending.state = state;
  pending.text = text ? [NSString stringWithUTF8String:text] : @"";
  pending.active = YES;
  pending.alert = [[NSAlert alloc] init];
  pending.alert.alertStyle = NSAlertStyleWarning;
  pending.alert.messageText = @"Paste multiple lines?";
  pending.alert.informativeText = @"The clipboard text contains multiple lines and could run commands in the terminal.";
  [pending.alert addButtonWithTitle:@"Cancel"];
  [pending.alert addButtonWithTitle:@"Paste"];
  [view.pendingClipboardConfirmations addObject:pending];
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] clipboard confirmation sheet id=%u request=%d bytes=%lu\n", view.surfaceId, (int)request, (unsigned long)[pending.text lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
  __weak ProsperoGhosttyView *weakView = view;
  [pending.alert beginSheetModalForWindow:view.window completionHandler:^(NSModalResponse response) {
    ProsperoGhosttyView *strongView = weakView;
    if (!strongView || strongView.surface != pending.surface) return;
    finishPendingClipboard(strongView, pending, response == NSAlertSecondButtonReturn);
  }];
}
static void writeClipboard(void *, ghostty_clipboard_e, const ghostty_clipboard_content_s *contents, size_t count, bool) {
  for (size_t i = 0; i < count; ++i) if (!strcmp(contents[i].mime, "text/plain")) {
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:[NSString stringWithUTF8String:contents[i].data] forType:NSPasteboardTypeString];
    break;
  }
}
static void closeSurface(void *userdata, bool) {
  ProsperoGhosttyView *view = (__bridge ProsperoGhosttyView *)userdata;
  cancelPendingClipboardConfirmations(view);
  view.hidden = YES;
}
static std::string str(napi_env env, napi_value value) {
  size_t n = 0; napi_get_value_string_utf8(env, value, nullptr, 0, &n);
  std::string s(n + 1, '\0'); napi_get_value_string_utf8(env, value, s.data(), n + 1, &n); s.resize(n); return s;
}
static napi_value undefined(napi_env e) { napi_value v; napi_get_undefined(e, &v); return v; }
static napi_value fail(napi_env e, const char *s) { napi_throw_error(e, nullptr, s); return nullptr; }
static double number(napi_env e, napi_value o, const char *key) { napi_value v; double n = 0; napi_get_named_property(e, o, key, &v); napi_get_value_double(e, v, &n); return n; }
static bool boolean(napi_env e, napi_value o, const char *key) { napi_value v; bool b = false; napi_get_named_property(e, o, key, &v); napi_get_value_bool(e, v, &b); return b; }
static napi_value initialize(napi_env e, napi_callback_info info) {
  if (app) return undefined(e);
  size_t n = 2; napi_value args[2]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  if (n != 2) return fail(e, "Expected config and resource paths");
  auto resources = str(e, args[1]); setenv("GHOSTTY_RESOURCES_DIR", resources.c_str(), 1);
  if (ghostty_init(0, nullptr) != 0) return fail(e, "Ghostty initialization failed");
  config = ghostty_config_new(); auto path = str(e, args[0]); ghostty_config_load_file(config, path.c_str()); ghostty_config_finalize(config);
  ghostty_runtime_config_s runtime = {};
  runtime.wakeup_cb = wakeup; runtime.action_cb = action; runtime.read_clipboard_cb = readClipboard;
  runtime.confirm_read_clipboard_cb = confirmClipboard; runtime.write_clipboard_cb = writeClipboard; runtime.close_surface_cb = closeSurface;
  app = ghostty_app_new(&runtime, config);
  if (!app) return fail(e, "Ghostty app creation failed");
  views = [[NSMutableDictionary alloc] init];
  return undefined(e);
}
static napi_value create(napi_env e, napi_callback_info info) {
  size_t n = 3; napi_value args[3]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  if (!app || n != 3) return fail(e, "Ghostty not initialized");
  void *data; size_t size;
  if (napi_get_buffer_info(e, args[0], &data, &size) != napi_ok || size != sizeof(void *)) return fail(e, "Invalid native window handle");
  id nativeObject = (__bridge id)*(void **)data;
  NSView *parent = nil;
  if ([nativeObject isKindOfClass:NSView.class]) parent = (NSView *)nativeObject;
  else if ([nativeObject isKindOfClass:NSWindow.class]) parent = ((NSWindow *)nativeObject).contentView;
  if (!parent) return fail(e, "Native window handle is not an NSView or NSWindow with a content view");
  auto command = str(e, args[1]);
  bool hasConfigPath = false; napi_has_named_property(e, args[2], "configPath", &hasConfigPath);
  std::string configPath;
  if (hasConfigPath) {
    napi_value pathValue; napi_valuetype pathType;
    napi_get_named_property(e, args[2], "configPath", &pathValue); napi_typeof(e, pathValue, &pathType);
    if (pathType != napi_string) return fail(e, "Per-surface configPath must be a string");
    configPath = str(e, pathValue);
    if (configPath.empty()) return fail(e, "Per-surface configPath must not be empty");
  }
  bool hasFontFamily = false; napi_has_named_property(e, args[2], "fontFamily", &hasFontFamily);
  if (hasFontFamily && !hasConfigPath) return fail(e, "A per-surface fontFamily requires configPath");
  if (hasFontFamily) {
    napi_value familyValue; napi_valuetype familyType;
    napi_get_named_property(e, args[2], "fontFamily", &familyValue); napi_typeof(e, familyValue, &familyType);
    if (familyType != napi_string || str(e, familyValue).empty()) return fail(e, "Per-surface fontFamily must be a nonempty string");
  }
  ghostty_config_t surfaceConfig = nullptr;
  if (hasConfigPath) {
    surfaceConfig = ghostty_config_clone(config);
    if (!surfaceConfig) return fail(e, "Could not clone Ghostty config for surface");
    ghostty_config_load_file(surfaceConfig, configPath.c_str());
    ghostty_config_finalize(surfaceConfig);
  }
  ProsperoGhosttyView *view = [[ProsperoGhosttyView alloc] initWithFrame:NSMakeRect(0, 0, 800, 600)];
  view.hidden = YES; view.readOnly = YES; [parent addSubview:view positioned:NSWindowAbove relativeTo:nil];
  if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] create surface parent=%s window=%p number=%ld scale=%.2f parentFrame={%.1f,%.1f,%.1f,%.1f} parentBounds={%.1f,%.1f,%.1f,%.1f} surfaceFrame={%.1f,%.1f,%.1f,%.1f} config=%s\n",
    object_getClassName(parent), (__bridge void *)parent.window, (long)parent.window.windowNumber, parent.window.backingScaleFactor,
    parent.frame.origin.x, parent.frame.origin.y, parent.frame.size.width, parent.frame.size.height,
    parent.bounds.origin.x, parent.bounds.origin.y, parent.bounds.size.width, parent.bounds.size.height,
    view.frame.origin.x, view.frame.origin.y, view.frame.size.width, view.frame.size.height,
    hasConfigPath ? configPath.c_str() : "<shared>");
  ghostty_surface_config_s cfg = ghostty_surface_config_new();
  cfg.platform_tag = GHOSTTY_PLATFORM_MACOS; cfg.platform.macos.nsview = (__bridge void *)view;
  cfg.userdata = (__bridge void *)view; cfg.scale_factor = parent.window.backingScaleFactor;
  cfg.font_size = number(e, args[2], "fontSize"); cfg.command = command.c_str(); cfg.wait_after_command = true;
  view.surface = ghostty_surface_new(app, &cfg);
  if (!view.surface) {
    if (getenv("PROSPERO_NATIVE_GHOSTTY_DEBUG")) fprintf(stderr, "[native-ghostty] surface creation failed parentWindow=%p viewWindow=%p viewHidden=%d contentScale=%.2f fontSize=%.2f commandLength=%lu\n",
      (__bridge void *)parent.window, (__bridge void *)view.window, view.hidden, cfg.scale_factor, cfg.font_size, (unsigned long)command.size());
    if (surfaceConfig) ghostty_config_free(surfaceConfig); [view removeFromSuperview]; return fail(e, "Ghostty surface creation failed");
  }
  if (surfaceConfig) { ghostty_surface_update_config(view.surface, surfaceConfig); ghostty_config_free(surfaceConfig); }
  [view updateDisplayID];
  [view syncSize]; uint32_t id = nextId++; view.surfaceId = id; views[@(id)] = view;
  napi_value result; napi_create_uint32(e, id, &result); return result;
}
static napi_value update(napi_env e, napi_callback_info info) {
  size_t n = 2; napi_value args[2]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  if (n != 2) return fail(e, "Expected surface and bounds");
  uint32_t id; napi_get_value_uint32(e, args[0], &id); ProsperoGhosttyView *v = views[@(id)];
  if (!v) return undefined(e);
  double x = number(e, args[1], "x"), y = number(e, args[1], "y"), w = number(e, args[1], "width"), h = number(e, args[1], "height");
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(w) || !std::isfinite(h) || w < 0 || h < 0) return fail(e, "Invalid surface bounds");
  if (!v.superview.isFlipped) y = v.superview.bounds.size.height - y - h;
  ghostty_surface_size_s preservedSize = {};
  bool hasPreserveGrid; napi_has_named_property(e, args[1], "preserveGrid", &hasPreserveGrid);
  bool preserveGrid = hasPreserveGrid && boolean(e, args[1], "preserveGrid");
  if (preserveGrid) preservedSize = ghostty_surface_size(v.surface);
  v.frame = NSMakeRect(x, y, w, h);
  if (preserveGrid) ghostty_surface_set_size(v.surface, preservedSize.width_px, preservedSize.height_px);
  BOOL visible = boolean(e, args[1], "visible") && w > 0 && h > 0;
  v.hidden = !visible; ghostty_surface_set_occlusion(v.surface, visible);
  if (!visible) [v cancelNativeActivationFocus];
  if (!visible && v.window.firstResponder == v) [v.window makeFirstResponder:v.superview];
  bool hasFocus; napi_has_named_property(e, args[1], "focus", &hasFocus);
  if (visible && hasFocus) {
    BOOL focus = boolean(e, args[1], "focus");
    if (focus) { v.wantsNativeFocusAfterActivation = YES; [v.window makeFirstResponder:v]; }
    else {
      [v cancelNativeActivationFocus];
      if (v.window.firstResponder == v) [v.window makeFirstResponder:v.superview];
    }
  }
  return undefined(e);
}
static napi_value destroy(napi_env e, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(e, info, &n, &arg, nullptr, nullptr);
  uint32_t id; if (n != 1 || napi_get_value_uint32(e, arg, &id) != napi_ok) return fail(e, "Invalid surface ID");
  ProsperoGhosttyView *v = views[@(id)];
  if (v) { cancelPendingClipboardConfirmations(v); [v cancelNativeActivationFocus]; if (v.window.firstResponder == v) [v.window makeFirstResponder:v.superview]; ghostty_surface_free(v.surface); v.surface = nullptr; [v removeFromSuperview]; [views removeObjectForKey:@(id)]; }
  return undefined(e);
}
static napi_value sizeObject(napi_env e, ghostty_surface_size_s measured) {
  napi_value result;
  napi_create_object(e, &result);
  napi_value value;
  napi_create_uint32(e, measured.columns, &value); napi_set_named_property(e, result, "columns", value);
  napi_create_uint32(e, measured.rows, &value); napi_set_named_property(e, result, "rows", value);
  napi_create_uint32(e, measured.width_px, &value); napi_set_named_property(e, result, "width", value);
  napi_create_uint32(e, measured.height_px, &value); napi_set_named_property(e, result, "height", value);
  napi_create_uint32(e, measured.cell_width_px, &value); napi_set_named_property(e, result, "cellWidth", value);
  napi_create_uint32(e, measured.cell_height_px, &value); napi_set_named_property(e, result, "cellHeight", value);
  return result;
}
static bool surfaceFor(napi_env e, napi_value idValue, uint32_t *id, ProsperoGhosttyView **view) {
  if (napi_get_value_uint32(e, idValue, id) != napi_ok) return false;
  *view = views[@(*id)];
  return *view != nil && (*view).surface != nullptr;
}
static napi_value size(napi_env e, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(e, info, &n, &arg, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v;
  if (n != 1 || !surfaceFor(e, arg, &id, &v)) return fail(e, "Invalid Ghostty surface ID");
  return sizeObject(e, ghostty_surface_size(v.surface));
}
static napi_value setGrid(napi_env e, napi_callback_info info) {
  size_t n = 3; napi_value args[3]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  uint32_t id, columns, rows; ProsperoGhosttyView *v;
  if (n != 3 || !surfaceFor(e, args[0], &id, &v) ||
      napi_get_value_uint32(e, args[1], &columns) != napi_ok ||
      napi_get_value_uint32(e, args[2], &rows) != napi_ok ||
      columns == 0 || rows == 0 || columns > UINT16_MAX || rows > UINT16_MAX) {
    return fail(e, "Expected a valid surface ID and nonzero grid dimensions");
  }
  ghostty_surface_size_s measured = ghostty_surface_size(v.surface);
  if (measured.cell_width_px == 0 || measured.cell_height_px == 0) return fail(e, "Ghostty surface has no measured cell size");
  uint32_t horizontalSlack = measured.width_px > measured.columns * measured.cell_width_px ? measured.width_px - measured.columns * measured.cell_width_px : 0;
  uint32_t verticalSlack = measured.height_px > measured.rows * measured.cell_height_px ? measured.height_px - measured.rows * measured.cell_height_px : 0;
  uint64_t width = (uint64_t)columns * measured.cell_width_px + horizontalSlack;
  uint64_t height = (uint64_t)rows * measured.cell_height_px + verticalSlack;
  if (width > UINT32_MAX || height > UINT32_MAX) return fail(e, "Requested grid is too large");
  ghostty_surface_set_size(v.surface, (uint32_t)width, (uint32_t)height);
  return sizeObject(e, ghostty_surface_size(v.surface));
}
static napi_value readText(napi_env e, napi_callback_info info) {
  size_t n = 2; napi_value args[2]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v; bool viewport = false;
  if ((n != 1 && n != 2) || !surfaceFor(e, args[0], &id, &v)) return fail(e, "Invalid Ghostty surface ID");
  if (n == 2) napi_get_value_bool(e, args[1], &viewport);
  ghostty_selection_s selection = {};
  selection.top_left.tag = viewport ? GHOSTTY_POINT_VIEWPORT : GHOSTTY_POINT_SCREEN;
  selection.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT;
  selection.bottom_right.tag = viewport ? GHOSTTY_POINT_VIEWPORT : GHOSTTY_POINT_SCREEN;
  selection.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_text(v.surface, selection, &text)) return fail(e, "Could not read Ghostty surface text");
  napi_value result;
  napi_create_string_utf8(e, text.text ? text.text : "", text.text_len, &result);
  ghostty_surface_free_text(v.surface, &text);
  return result;
}
static napi_value inputText(napi_env e, napi_callback_info info) {
  size_t n = 2; napi_value args[2]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v;
  if (n != 2 || !surfaceFor(e, args[0], &id, &v)) return fail(e, "Invalid Ghostty surface ID");
  if (v.readOnly) return fail(e, "Native terminal is read-only");
  auto text = str(e, args[1]);
  ghostty_surface_text(v.surface, text.data(), text.size());
  return undefined(e);
}
static napi_value testIMECommit(napi_env e, napi_callback_info info) {
  size_t n = 3; napi_value args[3]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v;
  if (n != 3 || !surfaceFor(e, args[0], &id, &v)) return fail(e, "Invalid Ghostty surface ID");
  if (v.readOnly) return fail(e, "Native terminal is read-only");
  std::string preeditBytes = str(e, args[1]), committedBytes = str(e, args[2]);
  NSString *preedit = [[NSString alloc] initWithBytes:preeditBytes.data() length:preeditBytes.size() encoding:NSUTF8StringEncoding];
  NSString *committed = [[NSString alloc] initWithBytes:committedBytes.data() length:committedBytes.size() encoding:NSUTF8StringEncoding];
  if (!preedit || !committed) return fail(e, "IME test text must be valid UTF-8");
  [v setMarkedText:preedit selectedRange:NSMakeRange(preedit.length, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
  [v insertText:committed replacementRange:NSMakeRange(NSNotFound, 0)];
  return undefined(e);
}
static napi_value isVisible(napi_env e, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(e, info, &n, &arg, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v;
  if (n != 1 || !surfaceFor(e, arg, &id, &v)) return fail(e, "Invalid Ghostty surface ID");
  napi_value result;
  napi_get_boolean(e, !v.hidden && ![v isHiddenOrHasHiddenAncestor] && v.window.isVisible, &result);
  return result;
}
static napi_value setReadOnly(napi_env e, napi_callback_info info) {
  size_t n = 2; napi_value args[2]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v; bool readOnly;
  if (n != 2 || !surfaceFor(e, args[0], &id, &v) || napi_get_value_bool(e, args[1], &readOnly) != napi_ok) return fail(e, "Expected a valid surface ID and read-only state");
  v.readOnly = readOnly;
  if (readOnly && v.hasMarkedText) [v unmarkText];
  return undefined(e);
}
static napi_value inspect(napi_env e, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(e, info, &n, &arg, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v;
  if (n != 1 || !surfaceFor(e, arg, &id, &v)) return fail(e, "Invalid Ghostty surface ID");
  napi_value result;
  napi_create_object(e, &result);
  auto setBool = [&](const char *key, bool value) {
    napi_value field; napi_get_boolean(e, value, &field); napi_set_named_property(e, result, key, field);
  };
  auto setNumber = [&](const char *key, double value) {
    napi_value field; napi_create_double(e, value, &field); napi_set_named_property(e, result, key, field);
  };
  auto setString = [&](const char *key, NSString *value) {
    napi_value field; const char *utf8 = value.UTF8String ?: "";
    napi_create_string_utf8(e, utf8, NAPI_AUTO_LENGTH, &field); napi_set_named_property(e, result, key, field);
  };
  setBool("hidden", v.hidden);
  setBool("hiddenByAncestor", [v isHiddenOrHasHiddenAncestor]);
  setBool("readOnly", v.readOnly);
  setBool("ghosttyFocused", v.ghosttyFocused);
  setBool("isFlipped", v.isFlipped);
  setBool("hasWindow", v.window != nil);
  setBool("isKeyWindow", v.window.isKeyWindow);
  setNumber("windowNumber", v.window.windowNumber);
  setString("viewClass", NSStringFromClass(v.class));
  setString("superviewClass", v.superview ? NSStringFromClass(v.superview.class) : @"none");
  setString("firstResponderClass", v.window.firstResponder ? NSStringFromClass([v.window.firstResponder class]) : @"none");
  setBool("isFirstResponder", v.window.firstResponder == v);
  setNumber("frameX", v.frame.origin.x); setNumber("frameY", v.frame.origin.y);
  setNumber("frameWidth", v.frame.size.width); setNumber("frameHeight", v.frame.size.height);
  setNumber("boundsWidth", v.bounds.size.width); setNumber("boundsHeight", v.bounds.size.height);
  napi_value hierarchy; napi_create_array(e, &hierarchy);
  NSView *ancestor = v.superview;
  uint32_t index = 0;
  while (ancestor && index < 12) {
    napi_value node; napi_create_object(e, &node);
    NSString *className = NSStringFromClass(ancestor.class);
    napi_value classValue; napi_create_string_utf8(e, className.UTF8String, NAPI_AUTO_LENGTH, &classValue);
    napi_set_named_property(e, node, "class", classValue);
    napi_value rect; napi_create_object(e, &rect);
    napi_value field;
    napi_create_double(e, ancestor.frame.origin.x, &field); napi_set_named_property(e, rect, "x", field);
    napi_create_double(e, ancestor.frame.origin.y, &field); napi_set_named_property(e, rect, "y", field);
    napi_create_double(e, ancestor.frame.size.width, &field); napi_set_named_property(e, rect, "width", field);
    napi_create_double(e, ancestor.frame.size.height, &field); napi_set_named_property(e, rect, "height", field);
    napi_set_named_property(e, node, "frame", rect);
    napi_get_boolean(e, ancestor.isFlipped, &field); napi_set_named_property(e, node, "isFlipped", field);
    napi_set_element(e, hierarchy, index++, node);
    ancestor = ancestor.superview;
  }
  napi_set_named_property(e, result, "parentHierarchy", hierarchy);
  return result;
}
static napi_value bindingAction(napi_env e, napi_callback_info info) {
  size_t n = 2; napi_value args[2]; napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  uint32_t id; ProsperoGhosttyView *v;
  if (n != 2 || !surfaceFor(e, args[0], &id, &v)) return fail(e, "Invalid Ghostty surface ID");
  auto command = str(e, args[1]);
  bool performed = ghostty_surface_binding_action(v.surface, command.c_str(), command.size());
  napi_value result; napi_get_boolean(e, performed, &result); return result;
}
static napi_value setShortcutHandler(napi_env e, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(e, info, &n, &arg, nullptr, nullptr);
  if (n != 1) return fail(e, "Expected a shortcut callback or null");
  if (!setCallback(&shortcutCallback, e, arg)) return fail(e, "Shortcut callback must be a function or null");
  return undefined(e);
}
static napi_value setFocusHandler(napi_env e, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(e, info, &n, &arg, nullptr, nullptr);
  if (n != 1) return fail(e, "Expected a focus callback or null");
  if (!setCallback(&focusCallback, e, arg)) return fail(e, "Focus callback must be a function or null");
  return undefined(e);
}
static napi_value setPasteImageHandler(napi_env e, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(e, info, &n, &arg, nullptr, nullptr);
  if (n != 1) return fail(e, "Expected an image paste callback or null");
  if (!setCallback(&imagePasteCallback, e, arg)) return fail(e, "Image paste callback must be a function or null");
  return undefined(e);
}
NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {{"initialize", 0, initialize, 0, 0, 0, napi_default, 0}, {"create", 0, create, 0, 0, 0, napi_default, 0}, {"update", 0, update, 0, 0, 0, napi_default, 0}, {"destroy", 0, destroy, 0, 0, 0, napi_default, 0}, {"size", 0, size, 0, 0, 0, napi_default, 0}, {"setGrid", 0, setGrid, 0, 0, 0, napi_default, 0}, {"readText", 0, readText, 0, 0, 0, napi_default, 0}, {"inputText", 0, inputText, 0, 0, 0, napi_default, 0}, {"testIMECommit", 0, testIMECommit, 0, 0, 0, napi_default, 0}, {"isVisible", 0, isVisible, 0, 0, 0, napi_default, 0}, {"setReadOnly", 0, setReadOnly, 0, 0, 0, napi_default, 0}, {"inspect", 0, inspect, 0, 0, 0, napi_default, 0}, {"bindingAction", 0, bindingAction, 0, 0, 0, napi_default, 0}, {"setShortcutHandler", 0, setShortcutHandler, 0, 0, 0, napi_default, 0}, {"setFocusHandler", 0, setFocusHandler, 0, 0, 0, napi_default, 0}, {"setPasteImageHandler", 0, setPasteImageHandler, 0, 0, 0, napi_default, 0}};
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props); return exports;
}
