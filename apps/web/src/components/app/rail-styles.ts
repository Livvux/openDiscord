// Plain strings, so server components (the rail itself) can use them too.
/** Discord's tile shape: a circle that morphs into a rounded square on hover and while open. */
export const railShape = (active: boolean) =>
  `relative grid size-12 place-items-center transition-[border-radius,background-color,color] duration-200 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none ${active ? "rounded-2xl" : "rounded-[24px] hover:rounded-2xl"}`;

export const railTile = (active: boolean) =>
  `${railShape(active)} ${active ? "bg-primary text-primary-foreground" : "bg-white/[0.08] hover:bg-primary hover:text-primary-foreground"}`;
