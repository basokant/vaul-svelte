import { derived, get, writable, type Readable } from 'svelte/store';
import type { SvelteEvent } from './types.js';
import { createSnapPoints } from './snap-points.js';
import {
	overridable,
	toWritableStores,
	omit,
	type ChangeFn,
	getTranslateY,
	set,
	reset,
	effect,
	removeUndefined,
	styleToString
} from '$lib/internal/helpers/index.js';
import { isIOS, isInput, usePreventScroll } from './prevent-scroll.js';
import { usePositionFixed } from './position-fixed.js';
import { onMount } from 'svelte';
import { TRANSITIONS, VELOCITY_THRESHOLD } from './constants.js';
import { addEventListener } from './helpers/event.js';
import { noop } from './helpers/noop.js';
import { useEscapeKeydown } from './escape-keydown.js';

const CLOSE_THRESHOLD = 0.25;

const SCROLL_LOCK_TIMEOUT = 100;

const BORDER_RADIUS = 8;

const NESTED_DISPLACEMENT = 16;

const WINDOW_TOP_OFFSET = 26;

const DRAG_CLASS = 'vaul-dragging';

type WithFadeFromProps = {
	snapPoints: (number | string)[];
	fadeFromIndex: number;
};

type WithoutFadeFromProps = {
	snapPoints?: (number | string)[];
	fadeFromIndex?: never;
};

export type CreateVaulProps = {
	defaultActiveSnapPoint?: number | string | null;
	onActiveSnapPointChange?: ChangeFn<number | string | null>;
	defaultOpen?: boolean;
	onOpenChange?: ChangeFn<boolean>;
	closeThreshold?: number;
	shouldScaleBackground?: boolean;
	scrollLockTimeout?: number;
	fixed?: boolean;
	dismissible?: boolean;
	onDrag?: (event: SvelteEvent<PointerEvent, HTMLElement>, percentageDragged: number) => void;
	onRelease?: (event: SvelteEvent<PointerEvent | MouseEvent, HTMLElement>, open: boolean) => void;
	modal?: boolean;
	nested?: boolean;
	onClose?: () => void;
} & (WithFadeFromProps | WithoutFadeFromProps);

const defaultProps = {
	closeThreshold: CLOSE_THRESHOLD,
	shouldScaleBackground: true,
	scrollLockTimeout: SCROLL_LOCK_TIMEOUT,
	onDrag: undefined,
	onRelease: undefined,
	snapPoints: undefined,
	fadeFromIndex: undefined,
	defaultActiveSnapPoint: undefined,
	onActiveSnapPointChange: undefined,
	defaultOpen: false,
	onOpenChange: undefined,
	fixed: undefined,
	dismissible: true,
	modal: true,
	nested: false,
	onClose: undefined
};

const omittedOptions = [
	'defaultOpen',
	'onOpenChange',
	'defaultActiveSnapPoint',
	'onActiveSnapPointChange',
	'onDrag',
	'onRelease',
	'onClose'
] as const;

export function createVaul(props: CreateVaulProps) {
	const {
		snapPoints: snapPointsProp,
		fadeFromIndex: fadeFromIndexProp = snapPointsProp && snapPointsProp.length - 1,
		...withDefaults
	} = { ...defaultProps, ...removeUndefined(props) } satisfies CreateVaulProps;

	const options = toWritableStores(
		omit(
			{
				...withDefaults,
				snapPoints: snapPointsProp,
				fadeFromIndex: fadeFromIndexProp
			},
			...omittedOptions
		)
	);

	const { onDrag: onDragProp, onRelease: onReleaseProp, onClose, onOpenChange } = withDefaults;

	const {
		snapPoints,
		fadeFromIndex,
		fixed,
		dismissible,
		modal,
		nested,
		shouldScaleBackground,
		scrollLockTimeout,
		closeThreshold
	} = options;

	const openStore = writable(withDefaults.defaultOpen);
	const isOpen = overridable(openStore, withDefaults.onOpenChange);

	const hasBeenOpened = writable(false);
	const visible = writable(false);
	const mounted = writable(false);
	const isDragging = writable(false);
	const justReleased = writable(false);
	const overlayRef = writable<HTMLDivElement | undefined>(undefined);
	const openTime = writable<Date | null>(null);
	const dragStartTime = writable<Date | null>(null);
	const dragEndTime = writable<Date | null>(null);
	const lastTimeDragPrevented = writable<Date | null>(null);
	const isAllowedToDrag = writable(false);
	const nestedOpenChangeTimer = writable<NodeJS.Timeout | null>(null);
	const pointerStartY = writable(0);
	const keyboardIsOpen = writable(false);
	const previousDiffFromInitial = writable(0);
	const drawerRef = writable<HTMLDivElement | undefined>(undefined);
	const drawerHeightRef = writable(get(drawerRef)?.getBoundingClientRect().height || 0);
	const initialDrawerHeight = writable(0);
	let isClosing = false;

	function getDefaultActiveSnapPoint() {
		if (withDefaults.defaultActiveSnapPoint) {
			return withDefaults.defaultActiveSnapPoint;
		}
		if (snapPointsProp && snapPointsProp.length > 0) {
			return snapPointsProp[0];
		}
		return undefined;
	}

	const activeSnapPointStore = writable(getDefaultActiveSnapPoint());
	const activeSnapPoint = overridable(activeSnapPointStore, withDefaults.onActiveSnapPointChange);

	function onSnapPointChange(activeSnapPointIndex: number) {
		// Change openTime ref when we reach the last snap point to prevent dragging for 500ms incase it's scrollable.
		const $snapPoints = get(snapPoints);
		const $snapPointsOffset = get(snapPointsOffset);
		if ($snapPoints && activeSnapPointIndex === $snapPointsOffset.length - 1) {
			openTime.set(new Date());
		}
	}

	const {
		activeSnapPointIndex,
		getPercentageDragged: getSnapPointsPercentageDragged,
		onDrag: onDragSnapPoints,
		onRelease: onReleaseSnapPoints,
		shouldFade,
		snapPointsOffset
	} = createSnapPoints({
		snapPoints,
		activeSnapPoint,
		drawerRef,
		fadeFromIndex,
		overlayRef,
		onSnapPointChange
	});

	const getContentStyle: Readable<(style?: string | null) => string> = derived(
		[snapPointsOffset],
		([$snapPointsOffset]) => {
			return (style: string | null = '') => {
				if ($snapPointsOffset && $snapPointsOffset.length > 0) {
					return style;
				}
				const styleProp = styleToString({
					'--snap-point-height': `${$snapPointsOffset[0]!}px`
				});

				if (style) {
					return styleProp + style;
				}

				return styleProp;
			};
		}
	);

	effect([isOpen], ([$isOpen]) => {
		if (!$isOpen && get(shouldScaleBackground)) {
			const id = setTimeout(() => {
				reset(document.body, 'background');
			}, 200);

			return () => clearTimeout(id);
		}
	});

	effect([isOpen], ([$isOpen]) => {
		let unsub = () => {};

		if ($isOpen) {
			unsub = usePreventScroll();
		}

		return unsub;
	});

	const { restorePositionSetting } = usePositionFixed({ isOpen, modal, nested, hasBeenOpened });

	effect([drawerRef], ([$drawerRef]) => {
		let unsub = noop;

		if ($drawerRef) {
			const { destroy } = useEscapeKeydown($drawerRef, {
				handler: () => {
					closeDrawer();
				}
			});
			unsub = destroy;
		}

		return () => {
			unsub();
		};
	});

	function openDrawer() {
		if (isClosing) return;
		hasBeenOpened.set(true);
		isOpen.set(true);
	}

	function getScale() {
		return (window.innerWidth - WINDOW_TOP_OFFSET) / window.innerWidth;
	}

	function onPress(event: SvelteEvent<PointerEvent, HTMLElement>) {
		const $drawerRef = get(drawerRef);

		if (!get(dismissible) && !get(snapPoints)) return;
		if ($drawerRef && !$drawerRef.contains(event.target as Node)) return;
		drawerHeightRef.set($drawerRef?.getBoundingClientRect().height || 0);
		isDragging.set(true);
		dragStartTime.set(new Date());

		// iOS doesn't trigger mouseUp after scrolling so we need to listen to touched in order to disallow dragging
		if (isIOS()) {
			window.addEventListener('touchend', () => isAllowedToDrag.set(false), { once: true });
		}
		// Ensure we maintain correct pointer capture even when going outside of the drawer
		(event.target as HTMLElement).setPointerCapture(event.pointerId);

		pointerStartY.set(event.screenY);
	}

	function shouldDrag(el: EventTarget, isDraggingDown: boolean) {
		const $drawerRef = get(drawerRef);
		let element = el as HTMLElement;
		const highlightedText = window.getSelection()?.toString();
		const swipeAmount = $drawerRef ? getTranslateY($drawerRef) : null;
		const date = new Date();

		// Allow scrolling when animating
		const $openTime = get(openTime);

		if ($openTime && date.getTime() - $openTime.getTime() < 500) {
			return false;
		}

		if (swipeAmount !== null && swipeAmount > 0) {
			return true;
		}

		// Don't drag if there's highlighted text
		if (highlightedText && highlightedText.length > 0) {
			return false;
		}

		const $lastTimeDragPrevented = get(lastTimeDragPrevented);

		const $scrollLockTimeout = get(scrollLockTimeout);
		// Disallow dragging if drawer was scrolled within `scrollLockTimeout`
		if (
			$lastTimeDragPrevented &&
			date.getTime() - $lastTimeDragPrevented.getTime() < $scrollLockTimeout &&
			swipeAmount === 0
		) {
			lastTimeDragPrevented.set(date);
			return false;
		}

		if (isDraggingDown) {
			lastTimeDragPrevented.set(date);

			// We are dragging down so we should allow scrolling
			return false;
		}

		// Keep climbing up the DOM tree as long as there's a parent
		while (element) {
			// Check if the element is scrollable
			if (element.scrollHeight > element.clientHeight) {
				if (element.scrollTop !== 0) {
					lastTimeDragPrevented.set(new Date());

					// The element is scrollable and not scrolled to the top, so don't drag
					return false;
				}

				if (element.getAttribute('role') === 'dialog') {
					return true;
				}
			}

			// Move up to the parent element
			element = element.parentNode as HTMLElement;
		}

		// No scrollable parents not scrolled to the top found, so drag
		return true;
	}

	function onDrag(event: SvelteEvent<PointerEvent, HTMLElement>) {
		// We need to know how much of the drawer has been dragged in percentages so that we can transform background accordingly
		if (get(isDragging)) {
			const $pointerStartY = get(pointerStartY);
			const draggedDistance = $pointerStartY - event.screenY;
			const isDraggingDown = draggedDistance > 0;

			const $activeSnapPointIndex = get(activeSnapPointIndex);
			const $snapPoints = get(snapPoints);

			// Disallow dragging down to close when first snap point is the active one and dismissible prop is set to false.
			if ($snapPoints && $activeSnapPointIndex === 0 && !get(dismissible)) return;

			const $isAllowedToDrag = get(isAllowedToDrag);
			if (!$isAllowedToDrag && !shouldDrag(event.target as HTMLElement, isDraggingDown)) {
				return;
			}
			const $drawerRef = get(drawerRef);
			if (!$drawerRef) return;

			$drawerRef.classList.add(DRAG_CLASS);
			// If shouldDrag gave true once after pressing down on the drawer, we set isAllowedToDrag to true and it will remain true until we let go, there's no reason to disable dragging mid way, ever, and that's the solution to it
			isAllowedToDrag.set(true);

			set($drawerRef, {
				transition: 'none'
			});

			const $overlayRef = get(overlayRef);

			set($overlayRef, {
				transition: 'none'
			});

			if ($snapPoints) {
				onDragSnapPoints({ draggedDistance });
			}

			// Run this only if snapPoints are not defined or if we are at the last snap point (highest one)
			if (isDraggingDown && !$snapPoints) {
				const dampenedDraggedDistance = dampenValue(draggedDistance);

				set($drawerRef, {
					transform: `translate3d(0, ${Math.min(dampenedDraggedDistance * -1, 0)}px, 0)`
				});
				return;
			}

			// We need to capture last time when drag with scroll was triggered and have a timeout between
			const absDraggedDistance = Math.abs(draggedDistance);
			const wrapper = document.querySelector('[data-vaul-drawer-wrapper]');
			const $drawerRefHeight = get(drawerHeightRef);
			let percentageDragged = absDraggedDistance / $drawerRefHeight;
			const snapPointPercentageDragged = getSnapPointsPercentageDragged(
				absDraggedDistance,
				isDraggingDown
			);

			if (snapPointPercentageDragged !== null) {
				percentageDragged = snapPointPercentageDragged;
			}

			const opacityValue = 1 - percentageDragged;

			const $fadeFromIndex = get(fadeFromIndex);
			const $shouldFade = get(shouldFade);

			if ($shouldFade || ($fadeFromIndex && $activeSnapPointIndex === $fadeFromIndex - 1)) {
				onDragProp?.(event, percentageDragged);

				set(
					$overlayRef,
					{
						opacity: `${opacityValue}`,
						transition: 'none'
					},
					true
				);
			}

			if (wrapper && $overlayRef && get(shouldScaleBackground)) {
				// Calculate percentageDragged as a fraction (0 to 1)
				const scaleValue = Math.min(getScale() + percentageDragged * (1 - getScale()), 1);
				const borderRadiusValue = 8 - percentageDragged * 8;

				const translateYValue = Math.max(0, 14 - percentageDragged * 14);

				set(
					wrapper,
					{
						borderRadius: `${borderRadiusValue}px`,
						transform: `scale(${scaleValue}) translate3d(0, ${translateYValue}px, 0)`,
						transition: 'none'
					},
					true
				);
			}

			if (!$snapPoints) {
				set($drawerRef, {
					transform: `translate3d(0, ${absDraggedDistance}px, 0)`
				});
			}
		}
	}

	function scaleBackground(open: boolean) {
		const wrapper = document.querySelector('[data-vaul-drawer-wrapper]');

		if (!wrapper || !get(shouldScaleBackground)) return;

		if (open) {
			set(
				document.body,
				{
					background: 'black'
				},
				true
			);

			set(wrapper, {
				borderRadius: `${BORDER_RADIUS}px`,
				overflow: 'hidden',
				transform: `scale(${getScale()}) translate3d(0, calc(env(safe-area-inset-top) + 14px), 0)`,
				transformOrigin: 'top',
				transitionProperty: 'transform, border-radius',
				transitionDuration: `${TRANSITIONS.DURATION}s`,
				transitionTimingFunction: `cubic-bezier(${TRANSITIONS.EASE.join(',')})`
			});
		} else {
			// Exit
			reset(wrapper, 'overflow');
			reset(wrapper, 'transform');
			reset(wrapper, 'borderRadius');
			set(wrapper, {
				transitionProperty: 'transform, border-radius',
				transitionDuration: `${TRANSITIONS.DURATION}s`,
				transitionTimingFunction: `cubic-bezier(${TRANSITIONS.EASE.join(',')})`
			});
		}
	}

	effect(
		[activeSnapPointIndex, snapPoints, snapPointsOffset],
		([$activeSnapPointIndex, $snapPoints, $snapPointsOffset]) => {
			function onVisualViewportChange() {
				const $drawerRef = get(drawerRef);
				if (!$drawerRef) return;
				const $keyboardIsOpen = get(keyboardIsOpen);
				const $initialDrawerHeight = get(initialDrawerHeight);
				const focusedElement = document.activeElement as HTMLElement;
				if (isInput(focusedElement) || $keyboardIsOpen) {
					const visualViewportHeight = window.visualViewport?.height || 0;
					// This is the height of the keyboard
					let diffFromInitial = window.innerHeight - visualViewportHeight;
					const drawerHeight = $drawerRef.getBoundingClientRect().height || 0;
					if (!$initialDrawerHeight) {
						initialDrawerHeight.set(drawerHeight);
					}
					const offsetFromTop = $drawerRef.getBoundingClientRect().top;

					// visualViewport height may change due to some subtle changes to the keyboard. Checking if the height changed by 60 or more will make sure that they keyboard really changed its open state.
					const $previousDiffFromInitial = get(previousDiffFromInitial);
					if (Math.abs($previousDiffFromInitial - diffFromInitial) > 60) {
						keyboardIsOpen.set(!$keyboardIsOpen);
					}

					if ($snapPoints && $snapPoints.length > 0 && $snapPointsOffset && $activeSnapPointIndex) {
						const activeSnapPointHeight = $snapPointsOffset[$activeSnapPointIndex] || 0;
						diffFromInitial += activeSnapPointHeight;
					}

					previousDiffFromInitial.set(diffFromInitial);
					// We don't have to change the height if the input is in view, when we are here we are in the opened keyboard state so we can correctly check if the input is in view
					if (drawerHeight > visualViewportHeight || $keyboardIsOpen) {
						const height = $drawerRef.getBoundingClientRect().height;
						let newDrawerHeight = height;

						if (height > visualViewportHeight) {
							newDrawerHeight = visualViewportHeight - WINDOW_TOP_OFFSET;
						}
						// When fixed, don't move the drawer upwards if there's space, but rather only change it's height so it's fully scrollable when the keyboard is open
						if (get(fixed)) {
							$drawerRef.style.height = `${height - Math.max(diffFromInitial, 0)}px`;
						} else {
							$drawerRef.style.height = `${Math.max(
								newDrawerHeight,
								visualViewportHeight - offsetFromTop
							)}px`;
						}
					} else {
						$drawerRef.style.height = `${$initialDrawerHeight}px`;
					}

					if ($snapPoints && $snapPoints.length > 0 && !$keyboardIsOpen) {
						$drawerRef.style.bottom = `0px`;
					} else {
						// Negative bottom value would never make sense
						$drawerRef.style.bottom = `${Math.max(diffFromInitial, 0)}px`;
					}
				}
			}

			let removeListener = noop;

			if (window.visualViewport) {
				removeListener = addEventListener(window.visualViewport, 'resize', onVisualViewportChange);
			}

			return () => {
				removeListener();
			};
		}
	);

	function closeDrawer() {
		if (isClosing) return;
		const $drawerRef = get(drawerRef);
		if (!$drawerRef) return;
		const $snapPoints = get(snapPoints);

		onClose?.();
		set($drawerRef, {
			transform: `translate3d(0, 100%, 0)`,
			transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(',')})`
		});

		set(get(overlayRef), {
			opacity: '0',
			transition: `opacity ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(',')})`
		});

		scaleBackground(false);

		isClosing = true;
		setTimeout(() => {
			visible.set(false);
			isOpen.set(false);
			isClosing = false;
		}, 300);

		setTimeout(() => {
			if ($snapPoints) {
				activeSnapPoint.set($snapPoints[0]);
			}
		}, TRANSITIONS.DURATION * 1000); // seconds to ms
	}

	// This can be done much better

	effect([isOpen], ([$isOpen]) => {
		if ($isOpen) {
			hasBeenOpened.set(true);
		} else {
			closeDrawer();
		}
	});

	onMount(() => {
		mounted.set(true);
	});

	function resetDrawer() {
		const $drawerRef = get(drawerRef);
		if (!$drawerRef) return;
		const $overlayRef = get(overlayRef);
		const wrapper = document.querySelector('[data-vaul-drawer-wrapper]');
		const currentSwipeAmount = getTranslateY($drawerRef);

		set($drawerRef, {
			transform: 'translate3d(0, 0, 0)',
			transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(',')})`
		});

		set($overlayRef, {
			transition: `opacity ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(',')})`,
			opacity: '1'
		});

		const $shouldScaleBackground = get(shouldScaleBackground);
		const $isOpen = get(isOpen);

		// Don't reset background if swiped upwards
		if ($shouldScaleBackground && currentSwipeAmount && currentSwipeAmount > 0 && $isOpen) {
			set(
				wrapper,
				{
					borderRadius: `${BORDER_RADIUS}px`,
					overflow: 'hidden',
					transform: `scale(${getScale()}) translate3d(0, calc(env(safe-area-inset-top) + 14px), 0)`,
					transformOrigin: 'top',
					transitionProperty: 'transform, border-radius',
					transitionDuration: `${TRANSITIONS.DURATION}s`,
					transitionTimingFunction: `cubic-bezier(${TRANSITIONS.EASE.join(',')})`
				},
				true
			);
		}
	}

	function onRelease(event: SvelteEvent<PointerEvent | MouseEvent, HTMLElement>) {
		const $isDragging = get(isDragging);
		const $drawerRef = get(drawerRef);
		if (!$isDragging || !$drawerRef) return;

		const $isAllowedToDrag = get(isAllowedToDrag);

		if ($isAllowedToDrag && isInput(event.target as HTMLElement)) {
			// If we were just dragging, prevent focusing on inputs etc. on release
			(event.target as HTMLInputElement).blur();
		}
		$drawerRef.classList.remove(DRAG_CLASS);
		isAllowedToDrag.set(false);
		isDragging.set(false);

		const $dragEndTime = new Date();

		dragEndTime.set($dragEndTime);

		const swipeAmount = getTranslateY($drawerRef);

		if (
			(event.target && !shouldDrag(event.target, false)) ||
			!swipeAmount ||
			Number.isNaN(swipeAmount)
		)
			return;

		const $dragStartTime = get(dragStartTime);
		if ($dragStartTime === null) return;

		const timeTaken = $dragEndTime.getTime() - $dragStartTime.getTime();
		const distMoved = get(pointerStartY) - event.screenY;
		const velocity = Math.abs(distMoved) / timeTaken;

		if (velocity > 0.05) {
			// `justReleased` is needed to prevent the drawer from focusing on an input when the drag ends, as it's not the intent most of the time.
			justReleased.set(true);

			setTimeout(() => {
				justReleased.set(false);
			}, 200);
		}

		if (get(snapPoints)) {
			onReleaseSnapPoints({
				draggedDistance: distMoved,
				closeDrawer,
				velocity,
				dismissible: get(dismissible)
			});
			onReleaseProp?.(event, true);
			return;
		}

		// Moved upwards, don't do anything
		if (distMoved > 0) {
			resetDrawer();
			onReleaseProp?.(event, true);
			return;
		}

		if (velocity > VELOCITY_THRESHOLD) {
			closeDrawer();
			onReleaseProp?.(event, false);
			return;
		}

		const visibleDrawerHeight = Math.min(
			$drawerRef.getBoundingClientRect().height ?? 0,
			window.innerHeight
		);

		if (swipeAmount >= visibleDrawerHeight * get(closeThreshold)) {
			closeDrawer();
			onReleaseProp?.(event, false);
			return;
		}

		onReleaseProp?.(event, true);
		resetDrawer();
	}

	effect([isOpen], ([$isOpen]) => {
		if (!$isOpen) return;

		openTime.set(new Date());
		scaleBackground(true);
	});

	effect([visible], ([$visible]) => {
		if (!$visible) return;

		// Find all scrollable elements inside our drawer and assign a class to it so that we can disable overflow when dragging to prevent pointermove not being captured
		const $drawerRef = get(drawerRef);
		if (!$drawerRef) return;

		const children = $drawerRef.querySelectorAll('*');
		children.forEach((child: Element) => {
			const htmlChild = child as HTMLElement;
			if (
				htmlChild.scrollHeight > htmlChild.clientHeight ||
				htmlChild.scrollWidth > htmlChild.clientWidth
			) {
				htmlChild.classList.add('vaul-scrollable');
			}
		});
	});

	function onNestedOpenChange(o: boolean) {
		const scale = o ? (window.innerWidth - NESTED_DISPLACEMENT) / window.innerWidth : 1;
		const y = o ? -NESTED_DISPLACEMENT : 0;

		const $nestedOpenChangeTimer = get(nestedOpenChangeTimer);

		if ($nestedOpenChangeTimer) {
			window.clearTimeout($nestedOpenChangeTimer);
		}
		const $drawerRef = get(drawerRef);

		set($drawerRef, {
			transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(',')})`,
			transform: `scale(${scale}) translate3d(0, ${y}px, 0)`
		});

		if (o && !$drawerRef) return;

		nestedOpenChangeTimer.set(
			setTimeout(() => {
				set($drawerRef, {
					transition: 'none',
					transform: `translate3d(0, ${getTranslateY($drawerRef as HTMLElement)}px, 0)`
				});
			}, 500)
		);
	}

	function onNestedDrag(event: SvelteEvent<PointerEvent, HTMLElement>, percentageDragged: number) {
		if (percentageDragged < 0) return;
		const initialScale = (window.innerWidth - NESTED_DISPLACEMENT) / window.innerWidth;
		const newScale = initialScale + percentageDragged * (1 - initialScale);
		const newY = -NESTED_DISPLACEMENT + percentageDragged * NESTED_DISPLACEMENT;

		set(get(drawerRef), {
			transform: `scale(${newScale}) translate3d(0, ${newY}px, 0)`,
			transition: 'none'
		});
	}

	function onNestedRelease(_: SvelteEvent<PointerEvent | MouseEvent, HTMLElement>, o: boolean) {
		const scale = o ? (window.innerWidth - NESTED_DISPLACEMENT) / window.innerWidth : 1;
		const y = o ? -NESTED_DISPLACEMENT : 0;

		if (!o) return;

		set(get(drawerRef), {
			transition: `transform ${TRANSITIONS.DURATION}s cubic-bezier(${TRANSITIONS.EASE.join(',')})`,
			transform: `scale(${scale}) translate3d(0, ${y}px, 0)`
		});
	}

	return {
		states: {
			isOpen,
			hasBeenOpened,
			snapPoints,
			activeSnapPoint,
			snapPointsOffset,
			keyboardIsOpen,
			shouldFade,
			visible
		},
		helpers: {
			getContentStyle
		},
		methods: {
			closeDrawer,
			onOpenChange,
			onPress,
			onRelease,
			onDrag,
			scaleBackground,
			onNestedDrag,
			onNestedOpenChange,
			onNestedRelease,
			restorePositionSetting,
			openDrawer
		},
		refs: {
			drawerRef,
			overlayRef
		},
		options
	};
}

export function dampenValue(v: number) {
	return 8 * (Math.log(v + 1) - 2);
}
