import { ProfileScreen } from "@/ui/screens/student/ProfileScreen";
import { loadProfile } from "@/ui/views/student/profile";
import { updateProfile, withdraw, startDiscordLink } from "./actions";

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ link_error?: string; linked?: string; join_error?: string }>;
}) {
  const view = await loadProfile(await searchParams);
  return (
    <ProfileScreen
      view={view}
      updateProfileAction={updateProfile}
      withdrawAction={withdraw}
      startDiscordLinkAction={startDiscordLink}
    />
  );
}
