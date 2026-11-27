import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} from "discord.js";
import { passwordIsConfigured, createPasswordRecord, validateNewPassword, verifyPassword } from "./password.js";
import { getGuildConfig, saveGuildConfig } from "./store.js";

export async function showPasswordSetupModal(interaction, config = getGuildConfig(interaction.guildId)) {
  const alreadyConfigured = passwordIsConfigured(config.antiBot);
  const modal = new ModalBuilder()
    .setCustomId("futaba:password-save")
    .setTitle(alreadyConfigured ? "Trocar senha do Anti-Bot" : "Configurar senha do Anti-Bot");

  if (alreadyConfigured) {
    const current = new TextInputBuilder()
      .setCustomId("current_password")
      .setLabel("Senha atual")
      .setPlaceholder("Informe a senha atual para autorizar a troca")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(12)
      .setMaxLength(128);
    modal.addComponents(new ActionRowBuilder().addComponents(current));
  }

  const next = new TextInputBuilder()
    .setCustomId("new_password")
    .setLabel("Nova senha")
    .setPlaceholder("Mínimo de 12 caracteres, com letras e números")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(12)
    .setMaxLength(128);
  const confirm = new TextInputBuilder()
    .setCustomId("confirm_password")
    .setLabel("Confirmar nova senha")
    .setPlaceholder("Digite novamente a nova senha")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(12)
    .setMaxLength(128);
  modal.addComponents(new ActionRowBuilder().addComponents(next), new ActionRowBuilder().addComponents(confirm));
  return interaction.showModal(modal);
}

export async function handlePasswordSubmit(interaction) {
  const guildId = interaction.guildId;
  const isAdmin = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
    || interaction.user.id === interaction.guild?.ownerId;
  if (!isAdmin) {
    return interaction.reply({ content: "Somente a administração do servidor pode configurar esta senha.", ephemeral: true });
  }

  // A derivação scrypt pode levar mais que o prazo inicial de uma interação do Discord.
  await interaction.deferReply({ ephemeral: true });
  try {
    const config = getGuildConfig(guildId);
    const configured = passwordIsConfigured(config.antiBot);
    if (configured) {
      const current = interaction.fields.getTextInputValue("current_password");
      const validCurrent = await verifyPassword(current, config.antiBot.password);
      if (!validCurrent) {
        return interaction.editReply({ content: "Senha atual incorreta. A senha não foi alterada." });
      }
    }

    const next = interaction.fields.getTextInputValue("new_password");
    const confirm = interaction.fields.getTextInputValue("confirm_password");
    const validation = validateNewPassword(next);
    if (validation) return interaction.editReply({ content: validation });
    if (next !== confirm) {
      return interaction.editReply({ content: "A confirmação não corresponde à nova senha. Nada foi alterado." });
    }

    config.antiBot.password = await createPasswordRecord(next);
    await saveGuildConfig(guildId, config);
    return interaction.editReply({
      content: configured
        ? "Senha do Anti-Bot alterada com sucesso. A senha anterior não é mais válida."
        : "Primeira senha do Anti-Bot configurada com sucesso. Agora você pode ativar o módulo."
    });
  } catch (error) {
    console.error(`[Futaba] Falha ao salvar senha do Anti-Bot: ${error.stack || error.message}`);
    return interaction.editReply({ content: "Não foi possível salvar a senha. Nenhuma alteração foi confirmada." });
  }
}
