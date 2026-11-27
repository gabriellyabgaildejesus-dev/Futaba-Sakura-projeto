import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials
} from "discord.js";
import { loadStore, getGuildConfig } from "./store.js";
import { loadAppealsStore } from "./appeals-store.js";
import { startApiServer } from "./api.js";
import { handleMessageCreate } from "./moderation.js";
import {
  handleAuditLogEntry,
  handleGuildMemberAdd,
  processExpiredBotAuths,
  restoreExpiredRaidLockdowns
} from "./security.js";
import {
  handleFutabaCommand,
  handlePanelInteraction,
  registerCommands
} from "./commands.js";

const required = ["DISCORD_TOKEN", "CLIENT_ID", "POOL_PARTY_GUILD_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[Futaba] Variável obrigatória ausente: ${key}`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

let apiServer = null;

client.once(Events.ClientReady, async ready => {
  console.log(`[Futaba Sakura] Online como ${ready.user.tag}`);
  const allowedGuildId = process.env.POOL_PARTY_GUILD_ID;
  for (const guild of client.guilds.cache.values()) {
    if (guild.id !== allowedGuildId) {
      console.warn(`[Futaba] Servidor não autorizado detectado (${guild.id}); saindo para manter a exclusividade do POOL PARTY.`);
      await guild.leave().catch(error => console.error(`[Futaba] Não foi possível sair de ${guild.id}: ${error.message}`));
    }
  }
  try { apiServer = startApiServer(client); }
  catch (error) {
    console.error(`[Futaba API] Não foi possível iniciar a API: ${error.message}`);
    process.exitCode = 1;
    await client.destroy();
    return;
  }
  try {
    await registerCommands(client);
  } catch (error) {
    console.error(`[Futaba] Falha ao registrar comandos: ${error.stack || error.message}`);
  }
  // Reprocessa prazos persistidos após reinício da hospedagem.
  try {
    await processExpiredBotAuths(client);
    await restoreExpiredRaidLockdowns(client);
  } catch (error) {
    console.error(`[Futaba] Falha na recuperação de tarefas pendentes: ${error.stack || error.message}`);
  }
});

client.on(Events.MessageCreate, async message => {
  await handleMessageCreate(client, message);
});

client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id !== process.env.POOL_PARTY_GUILD_ID) return;
  try {
    await handleGuildMemberAdd(client, member);
  } catch (error) {
    console.error(`[Futaba] Falha ao processar entrada de membro: ${error.stack || error.message}`);
  }
});

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  if (guild.id !== process.env.POOL_PARTY_GUILD_ID) return;
  await handleAuditLogEntry(client, entry, guild);
});

client.on(Events.GuildCreate, async guild => {
  if (guild.id === process.env.POOL_PARTY_GUILD_ID) return;
  console.warn(`[Futaba] Entrada em servidor não autorizado (${guild.id}); saindo imediatamente.`);
  await guild.leave().catch(error => console.error(`[Futaba] Não foi possível sair de ${guild.id}: ${error.message}`));
});

client.on(Events.ChannelCreate, async channel => {
  if (!channel.guild || channel.guild.id !== process.env.POOL_PARTY_GUILD_ID) return;
  const config = getGuildConfig(channel.guild.id);
  const roleId = config.antiBot.quarantineRoleId;
  if (!roleId) return;
  const role = await channel.guild.roles.fetch(roleId).catch(() => null);
  if (!role) return;
  await channel.permissionOverwrites.edit(role, {
    ViewChannel: false,
    SendMessages: false,
    AddReactions: false,
    Connect: false,
    Speak: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false
  }, { reason: "Aplicar isolamento padrão a novos canais" }).catch(() => null);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.guildId && interaction.guildId !== process.env.POOL_PARTY_GUILD_ID) {
      if (interaction.isRepliable()) await interaction.reply({ content: "A Futaba Sakura está disponível exclusivamente no POOL PARTY.", ephemeral: true }).catch(() => null);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await handleFutabaCommand(client, interaction);
      return;
    }
    const handled = await handlePanelInteraction(client, interaction);
    if (handled !== false) return;
  } catch (error) {
    console.error(`[Futaba] Erro de interação: ${error.stack || error.message}`);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Não foi possível concluir essa operação. Verifique as permissões e tente novamente.", ephemeral: true }).catch(() => null);
    }
  }
});

client.on(Events.Warn, warning => console.warn(`[Discord.js] ${warning}`));
client.on(Events.Error, error => console.error(`[Discord.js] ${error.stack || error.message}`));

// Timers persistentes: a cada 10 s verifica bots sem autenticação e lockouts vencidos.
const maintenance = setInterval(async () => {
  if (!client.isReady()) return;
  try {
    await processExpiredBotAuths(client);
    await restoreExpiredRaidLockdowns(client);
  } catch (error) {
    console.error(`[Futaba] Erro na manutenção de segurança: ${error.stack || error.message}`);
  }
}, 10_000);
maintenance.unref?.();

await loadStore();
await loadAppealsStore();
await client.login(process.env.DISCORD_TOKEN);

async function shutdown(signal) {
  console.log(`[Futaba] Encerrando após ${signal}...`);
  clearInterval(maintenance);
  if (apiServer) await new Promise(resolve => apiServer.close(resolve));
  await client.destroy();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
