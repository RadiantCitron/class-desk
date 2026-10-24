// Shell(ui/shell)이 type-only로 가져다 쓰는 메뉴 항목 모양. Loader는 components를 import할 수 없어서 타입은 여기에 둔다.
export type NavItemView = { href: string; label: string; badge?: number };
