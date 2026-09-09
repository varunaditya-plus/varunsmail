import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FLOATING_WIDTH = 560;
const FLOATING_HEIGHT = 620;
const MINIMIZED_HEIGHT = 40;
const EDGE_GAP = 16;
const SNAP_DISTANCE = 48;

type Position = { x: number; y: number };
type Viewport = { width: number; height: number };

export type ComposeWindowControls = {
  isMinimized: boolean;
  isMaximized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onToggleMaximize: () => void;
  onDragStart: (event: PointerEvent<HTMLDivElement>) => void;
};

function getViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function getFloatingSize(viewport: Viewport, isMinimized = false) {
  return {
    width: Math.min(FLOATING_WIDTH, viewport.width - EDGE_GAP * 2),
    height: isMinimized
      ? MINIMIZED_HEIGHT
      : Math.min(FLOATING_HEIGHT, viewport.height - EDGE_GAP * 2),
  };
}

function getDefaultPosition(viewport: Viewport, isMinimized = false) {
  const size = getFloatingSize(viewport, isMinimized);
  return {
    x: viewport.width - size.width - EDGE_GAP,
    y: viewport.height - size.height - EDGE_GAP,
  };
}

function clampPosition(position: Position, viewport: Viewport, isMinimized = false) {
  const size = getFloatingSize(viewport, isMinimized);
  return {
    x: Math.min(Math.max(position.x, EDGE_GAP), viewport.width - size.width - EDGE_GAP),
    y: Math.min(Math.max(position.y, EDGE_GAP), viewport.height - size.height - EDGE_GAP),
  };
}

function snapPosition(position: Position, viewport: Viewport, isMinimized = false) {
  const size = getFloatingSize(viewport, isMinimized);
  const next = clampPosition(position, viewport, isMinimized);
  const right = viewport.width - size.width - EDGE_GAP;
  const bottom = viewport.height - size.height - EDGE_GAP;

  if (next.x - EDGE_GAP <= SNAP_DISTANCE) next.x = EDGE_GAP;
  if (right - next.x <= SNAP_DISTANCE) next.x = right;
  if (next.y - EDGE_GAP <= SNAP_DISTANCE) next.y = EDGE_GAP;
  if (bottom - next.y <= SNAP_DISTANCE) next.y = bottom;
  return next;
}

function isCenterTarget(x: number, y: number, viewport: Viewport) {
  return Math.abs(x - viewport.width / 2) <= 160 && Math.abs(y - viewport.height / 2) <= 120;
}

export function ComposeWindow({
  children,
}: {
  children: (controls: ComposeWindowControls) => ReactNode;
}) {
  const [viewport, setViewport] = useState(getViewport);
  const [position, setPosition] = useState(() => getDefaultPosition(getViewport()));
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(() => getViewport().width < 640);
  const [isDragging, setIsDragging] = useState(false);
  const [willMaximize, setWillMaximize] = useState(false);
  const restorePositionRef = useRef(position);

  useEffect(() => {
    const handleResize = () => {
      const nextViewport = getViewport();
      setViewport(nextViewport);
      setPosition((current) => clampPosition(current, nextViewport, isMinimized));
      if (nextViewport.width < 640) {
        setIsMinimized(false);
        setIsMaximized(true);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMinimized]);

  function maximize() {
    restorePositionRef.current = position;
    setIsMinimized(false);
    setIsMaximized(true);
  }

  function toggleMaximize() {
    if (isMaximized) {
      setIsMaximized(false);
      setPosition(clampPosition(restorePositionRef.current, viewport));
      return;
    }
    maximize();
  }

  function minimize() {
    if (!isMinimized) restorePositionRef.current = position;
    setIsMaximized(false);
    setIsMinimized(true);
    setPosition(getDefaultPosition(viewport, true));
  }

  function restore() {
    setIsMinimized(false);
    setPosition(clampPosition(restorePositionRef.current, viewport));
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();

    const currentViewport = getViewport();
    const wasMaximized = isMaximized;
    const minimized = isMinimized;
    const size = getFloatingSize(currentViewport, minimized);
    let startPosition = position;

    if (wasMaximized) {
      startPosition = clampPosition(
        { x: event.clientX - size.width / 2, y: EDGE_GAP },
        currentViewport,
        minimized,
      );
      setIsMaximized(false);
      setPosition(startPosition);
    }

    const offset = {
      x: event.clientX - startPosition.x,
      y: event.clientY - startPosition.y,
    };
    let nextPosition = startPosition;
    let shouldMaximize = false;
    setIsDragging(true);

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      nextPosition = clampPosition(
        { x: moveEvent.clientX - offset.x, y: moveEvent.clientY - offset.y },
        currentViewport,
        minimized,
      );
      shouldMaximize = isCenterTarget(moveEvent.clientX, moveEvent.clientY, currentViewport);
      setWillMaximize(shouldMaximize);
      setPosition(nextPosition);
    };

    const handleEnd = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      setIsDragging(false);
      setWillMaximize(false);

      if (shouldMaximize) {
        restorePositionRef.current = nextPosition;
        setIsMinimized(false);
        setIsMaximized(true);
      } else {
        setPosition(snapPosition(nextPosition, currentViewport, minimized));
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
  }

  const size = getFloatingSize(viewport, isMinimized);
  const style = isMaximized
    ? {
        left: EDGE_GAP,
        top: EDGE_GAP,
        width: viewport.width - EDGE_GAP * 2,
        height: viewport.height - EDGE_GAP * 2,
      }
    : { left: position.x, top: position.y, width: size.width, height: size.height };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {isDragging && willMaximize ? (
        <div
          className="pointer-events-none fixed inset-4 z-30 rounded-2xl border-2 border-blue-500/70 bg-blue-500/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.2)]"
          aria-hidden="true"
          data-compose-maximize-preview
        />
      ) : null}
      <section
        className={`fixed z-40 overflow-hidden rounded-xl shadow-2xl ${isDragging ? '' : 'transition-[left,top,width,height] duration-200 ease-out'}`}
        style={style}
        aria-label="New message"
        data-compose-window
        data-window-state={isMinimized ? 'minimized' : isMaximized ? 'maximized' : 'floating'}
      >
        {children({
          isMinimized,
          isMaximized,
          onMinimize: minimize,
          onRestore: restore,
          onToggleMaximize: toggleMaximize,
          onDragStart: startDrag,
        })}
      </section>
    </>,
    document.body,
  );
}
