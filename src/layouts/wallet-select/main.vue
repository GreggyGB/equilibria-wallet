<template>
    <q-layout view="hHh Lpr lFf">
        <q-layout-header class="shift-title">

            <template v-if="show_menu">
                <main-menu :disable-switch-wallet="true"/>
            </template>
            <template v-else>
                <q-btn class="cancel" icon="reply"
                       flat round dense
                       @click="cancel()"/>
            </template>

            <template>
                <q-toolbar-title>
                    <div class="flex items-center justify-center" style="margin-top:0px">
                        <div style="padding-left: auto; padding-right: auto; padding-top: auto; padding-bottom: auto;">
                            <img src="statics/xeq_logo_with_padding.png" height="60">
                        </div>
                    </div>
                </q-toolbar-title>
            </template>

        </q-layout-header>

        <q-page-container>
            <router-view ref="page"/>
        </q-page-container>

        <status-footer/>

    </q-layout>
</template>

<script>
import { mapState } from "vuex"

import SettingsModal from "components/settings"
import StatusFooter from "components/footer"
import MainMenu from "components/mainmenu"

export default {
    data () {
        return {}
    },
    computed: {
        show_menu () {
            return this.$route.name === "wallet-select"
        },
        page_title () {
            switch (this.$route.name) {
            case "wallet-create":
                return "Create new account"
            case "wallet-restore":
                return "Restore account from seed"
            case "wallet-import":
                return "Import account from file"
            case "wallet-import-view-only":
                return "Restore view-only account"
            case "wallet-import-legacy":
                return "Import account from legacy gui"
            case "wallet-import-old-gui":
                return "Import accounts from old GUI"
            case "wallet-created":
                return "Account created/restored"

            default:
            case "wallet-select":
                return "equilibria"
            }
        }
    },
    methods: {
        cancel () {
            this.$router.replace({ path: "/wallet-select" })
            this.$gateway.send("wallet", "close_wallet")
            setTimeout(() => {
                // short delay to prevent wallet data reaching the
                // websocket moments after we close and reset data
                this.$store.dispatch("gateway/resetWalletData")
            }, 250)
        }
    },
    components: {
        StatusFooter,
        MainMenu
    }
}
</script>

<style>
</style>
