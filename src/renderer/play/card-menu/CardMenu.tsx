/**
 * A Play card's ⋯ menu, genex.games' card menu in the app: the game's own items (Copy link,
 * remixing, Change cover), an admin's in its own block (Mobile support, Edit tags) and the two that
 * take the game down (Unpublish, Delete game). The ⋯ sits on the cover's corner and shows while the
 * card is hovered or focused; a right-click on the card opens the same menu. Items that need more
 * than a press open their dialog.
 */
import type { JSX, ReactNode } from "react";
import { useRef, useState } from "react";
import { PlayCardAction, type PlayCardMenu, PlayChangeKind, PlayChangeOutcome } from "../../../shared/play-manage.ts";
import { type PlayGame, playPageUrl } from "../../../shared/play.ts";
import { usePlayWeb } from "../../state/hooks.ts";
import { studio } from "../../state/studio.ts";
import { ToastTone } from "../../state/toasts.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon, type IconName } from "../../ui/icons.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { CardDialogProps } from "./DialogFoot.tsx";
import { CoverDialog } from "./CoverDialog.tsx";
import { curationOf, MobileShown, mobileShown } from "./manage-model.ts";
import { MobileDialog } from "./MobileDialog.tsx";
import { TagsDialog } from "./TagsDialog.tsx";

const WORDS = PLAY_CARD_MENU_WORDS;

/** The actions a press acts on at once; every other one opens its dialog. */
const AT_ONCE = new Set<PlayCardAction>([PlayCardAction.CopyLink, PlayCardAction.Remixing]);

/** Each action's glyph. */
const ICON: Record<PlayCardAction, IconName> = {
  [PlayCardAction.CopyLink]: "link",
  [PlayCardAction.Remixing]: "lock",
  [PlayCardAction.Cover]: "image",
  [PlayCardAction.Mobile]: "computer",
  [PlayCardAction.Tags]: "tag",
  [PlayCardAction.Unpublish]: "eye-off",
  [PlayCardAction.Delete]: "trash",
};

/** The mobile row's state, as its right edge reads it. */
const MOBILE_SHOWN: Record<MobileShown, string> = {
  ...WORDS.mobileState,
  [MobileShown.AutoFlagged]: WORDS.mobileAutoFlagged,
};

/** A row's name, its glyph and the state at its right edge, from the game's curation. */
function rowOf(action: PlayCardAction, game: PlayGame): { label: string; icon: IconName; state: string | null } {
  const curation = curationOf(game);
  if (action === PlayCardAction.Remixing && curation.remixOff)
    return { label: WORDS.allowRemixing, icon: "globe", state: null };
  const shown = action === PlayCardAction.Mobile ? mobileShown(curation) : null;
  return { label: WORDS.item[action], icon: ICON[action], state: shown ? MOBILE_SHOWN[shown] : null };
}

/** One row of the menu. */
function Row({
  action,
  game,
  onSelect,
}: {
  action: PlayCardAction;
  game: PlayGame;
  onSelect: (action: PlayCardAction) => void;
}): JSX.Element {
  const { label, icon, state } = rowOf(action, game);
  return (
    <DropdownMenuItem
      data-play-card-action={action}
      data-tone={action === PlayCardAction.Delete ? "danger" : undefined}
      className="play-card-menu-row"
      onSelect={() => onSelect(action)}
    >
      <Icon name={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {state && <span className="play-card-menu-state">{state}</span>}
    </DropdownMenuItem>
  );
}

/** The dialog an action opens, over the card it came from; closing it gives the ⋯ the focus back. */
function ActionDialog({ action, ...props }: CardDialogProps & { action: PlayCardAction }): ReactNode {
  switch (action) {
    case PlayCardAction.Mobile:
      return <MobileDialog {...props} />;
    case PlayCardAction.Tags:
      return <TagsDialog {...props} />;
    case PlayCardAction.Cover:
      return <CoverDialog {...props} />;
    case PlayCardAction.Unpublish:
    case PlayCardAction.Delete:
      return <ConfirmDialog action={action} {...props} />;
    default:
      return null;
  }
}

/** Remixing turned off or on at a press, and the toast that says how it went. */
async function toggleRemixing(game: PlayGame): Promise<void> {
  const allowed = curationOf(game).remixOff;
  try {
    const result = await studio().play.manage(game, { kind: PlayChangeKind.Remixing, allowed });
    if (result.outcome === PlayChangeOutcome.OwnRepo) {
      studio().notify(WORDS.remixing.ownRepo, ToastTone.Info);
      return;
    }
    studio().notify(allowed ? WORDS.remixing.on(game.title) : WORDS.remixing.off(game.title), ToastTone.Ok);
  } catch {
    studio().notify(WORDS.remixing.failed, ToastTone.Error);
  }
}

/** The ⋯ on a card and its menu; `open` is the card's, so a right-click anywhere on it opens the menu too. */
export function CardMenu({
  game,
  menu,
  open,
  onOpenChange,
}: {
  game: PlayGame;
  menu: PlayCardMenu;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [dialog, setDialog] = useState<PlayCardAction | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const web = usePlayWeb();
  const select = (action: PlayCardAction) => {
    if (!AT_ONCE.has(action)) {
      setDialog(action);
      return;
    }
    if (action === PlayCardAction.CopyLink) {
      void navigator.clipboard.writeText(playPageUrl(web, game.slug)).then(
        () => studio().notify(WORDS.linkCopied, ToastTone.Ok),
        () => studio().notify(WORDS.copyFailed, ToastTone.Error),
      );
      return;
    }
    void toggleRemixing(game);
  };
  const close = () => setDialog(null);
  const rows = (actions: readonly PlayCardAction[]) =>
    actions.map((action) => <Row key={action} action={action} game={game} onSelect={select} />);
  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="play-card-menu"
            aria-label={WORDS.trigger}
            title={WORDS.trigger}
            data-play-card-menu={game.slug}
          >
            <Icon name="more" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-64"
          onCloseAutoFocus={(event) => {
            // A dialog this menu opened takes the focus; the ⋯ gets it back when the dialog closes.
            if (dialog) event.preventDefault();
          }}
        >
          {rows(menu.game)}
          {menu.admin.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="play-card-menu-label">{WORDS.adminLabel}</DropdownMenuLabel>
              {rows(menu.admin)}
            </>
          )}
          <DropdownMenuSeparator />
          {rows(menu.end)}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog && <ActionDialog action={dialog} game={game} onClose={close} returnFocus={trigger} />}
    </>
  );
}
