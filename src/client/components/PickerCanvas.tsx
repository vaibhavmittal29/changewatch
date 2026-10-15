import React, { useState, useRef } from 'react';

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  selector: string;
  textPreview: string;
  isFragile: boolean;
  tagName: string;
}

interface PickerCanvasProps {
  screenshotBase64: string;
  elements: ElementBox[];
  naturalWidth: number;
  naturalHeight: number;
  onAssignSelector: (selector: string, action: 'watch' | 'ignore') => void;
  includeSelectors: string[];
  ignoreSelectors: string[];
}

export const PickerCanvas: React.FC<PickerCanvasProps> = ({
  screenshotBase64,
  elements,
  naturalWidth,
  naturalHeight,
  onAssignSelector,
  includeSelectors,
  ignoreSelectors,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [hovered, setHovered] = useState<ElementBox | null>(null);
  const [activeBox, setActiveBox] = useState<ElementBox | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = naturalWidth / rect.width;
    const scaleY = naturalHeight / rect.height;

    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // Find smallest matching bounding box for precision
    const matching = elements
      .filter(el => mouseX >= el.x && mouseX <= el.x + el.width && mouseY >= el.y && mouseY <= el.y + el.height)
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));

    setHovered(matching[0] || null);
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!imgRef.current || !containerRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const scaleX = naturalWidth / rect.width;
    const scaleY = naturalHeight / rect.height;

    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const target = hovered || elements
      .filter(el => mouseX >= el.x && mouseX <= el.x + el.width && mouseY >= el.y && mouseY <= el.y + el.height)
      .sort((a, b) => (a.width * a.height) - (b.width * b.height))[0];

    if (target) {
      const containerRect = containerRef.current.getBoundingClientRect();
      setPopoverPos({
        x: Math.min(Math.max(e.clientX - containerRect.left - 40, 20), containerRect.width - 270),
        y: Math.max(e.clientY - containerRect.top - 80, 20),
      });
      setActiveBox(target);
    }
  };

  // Convert natural coords to CSS percentage for scalable box rendering
  const toStyle = (box: ElementBox) => ({
    left: `${(box.x / naturalWidth) * 100}%`,
    top: `${(box.y / naturalHeight) * 100}%`,
    width: `${(box.width / naturalWidth) * 100}%`,
    height: `${(box.height / naturalHeight) * 100}%`,
  });

  return (
    <div
      ref={containerRef}
      className="relative select-none border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950 inline-block w-full"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHovered(null)}
      onClick={handleClick}
    >
      <img
        ref={imgRef}
        src={screenshotBase64}
        alt="Visual Picker Target"
        className="w-full h-auto block pointer-events-none"
      />

      {/* Render active Watch selectors (green borders) */}
      {elements.filter(el => includeSelectors.includes(el.selector)).map(el => (
        <div
          key={`inc-${el.selector}`}
          style={toStyle(el)}
          className="absolute border-2 border-emerald-500 bg-emerald-500/15 pointer-events-none z-10"
        />
      ))}

      {/* Render active Ignore selectors (red borders) */}
      {elements.filter(el => ignoreSelectors.includes(el.selector)).map(el => (
        <div
          key={`ign-${el.selector}`}
          style={toStyle(el)}
          className="absolute border-2 border-rose-500 bg-rose-500/15 pointer-events-none z-10"
        />
      ))}

      {/* Hover Outline */}
      {hovered && (
        <div
          style={toStyle(hovered)}
          className="absolute border-2 border-indigo-400 bg-indigo-500/20 pointer-events-none z-20 transition-all duration-75"
        >
          <div className="absolute top-0 left-0 -translate-y-full bg-zinc-900 border border-zinc-700 text-xs px-2 py-1 rounded shadow-xl text-zinc-100 whitespace-nowrap max-w-xs truncate flex items-center gap-1.5">
            <span className="font-mono text-indigo-300 font-medium">{hovered.selector}</span>
            {hovered.isFragile && (
              <span className="text-amber-400 font-semibold text-[10px] bg-amber-950/80 px-1 py-0.5 rounded border border-amber-800">
                Fragile
              </span>
            )}
          </div>
        </div>
      )}

      {/* Click Action Popover */}
      {activeBox && popoverPos && (
        <div
          style={{ left: `${popoverPos.x}px`, top: `${popoverPos.y}px` }}
          className="absolute z-30 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-3 w-64 text-zinc-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between pb-2 border-b border-zinc-800 mb-2">
            <span className="text-xs font-mono font-bold text-zinc-300 truncate max-w-[170px]">
              {activeBox.selector}
            </span>
            <button
              onClick={() => setActiveBox(null)}
              className="text-zinc-500 hover:text-zinc-300 text-xs p-1"
            >
              ✕
            </button>
          </div>

          {activeBox.textPreview && (
            <p className="text-xs text-zinc-400 italic mb-2 line-clamp-2">
              &quot;{activeBox.textPreview}&quot;
            </p>
          )}

          {activeBox.isFragile && (
            <div className="mb-2 text-[11px] text-amber-400 bg-amber-950/40 border border-amber-800/60 rounded px-2 py-1">
              Warning: Selector uses auto-generated class names and may break on redeploy.
            </div>
          )}

          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => {
                onAssignSelector(activeBox.selector, 'watch');
                setActiveBox(null);
              }}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-1.5 px-2 rounded transition flex items-center justify-center gap-1"
            >
              Watch
            </button>
            <button
              type="button"
              onClick={() => {
                onAssignSelector(activeBox.selector, 'ignore');
                setActiveBox(null);
              }}
              className="flex-1 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold py-1.5 px-2 rounded transition flex items-center justify-center gap-1"
            >
              Ignore
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
