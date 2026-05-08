/**
 * Wallet Sidebar
 *
 * The right-side identity & wallet panel. Built from the shared sidebar
 * controller; mutual exclusion with sibling sidebars (e.g. the AI sidebar)
 * is handled inside the controller.
 */

import { createSidebarController } from './sidebar-controller.js';

const controller = createSidebarController({
  id: 'sidebar',
  toggleBtnId: 'wallet-toggle-btn',
  closeBtnId: 'sidebar-close',
  featureFlagKey: 'enableIdentityWallet',
  keybindingKey: 'W',
  name: 'wallet',
});

export const initSidebar = controller.init;
export const toggle = controller.toggle;
export const open = controller.open;
export const close = controller.close;
export const isVisible = controller.isVisible;
export const isFeatureEnabled = controller.isFeatureEnabled;
