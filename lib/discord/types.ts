export type DiscordRoleClient = {
  grantRole(discordUserId: string, roleId: string): Promise<void>;
  revokeRole(discordUserId: string, roleId: string): Promise<void>;
};

export type DiscordGuildClient = {
  addMember(discordUserId: string, accessToken: string): Promise<void>;
};
