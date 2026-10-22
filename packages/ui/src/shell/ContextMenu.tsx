import { MenuItem, Popover } from "./Popover";

export interface ContextMenuItem {
  readonly label: string;
  readonly run: () => void;
}

/** A right-click menu at a position inside the canvas. */
export function ContextMenu(props: {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
}) {
  return (
    <div className="absolute" style={{ left: props.x, top: props.y }}>
      <Popover label="Node" className="min-w-48" onClose={props.onClose}>
        {props.items.map((item) => (
          <MenuItem
            key={item.label}
            onSelect={() => {
              props.onClose();
              item.run();
            }}
          >
            {item.label}
          </MenuItem>
        ))}
      </Popover>
    </div>
  );
}
