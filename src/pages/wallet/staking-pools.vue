<template>
    <q-page>

        <div class="row q-pt-sm q-mx-md q-mb-sm items-end non-selectable">

            <div style="padding-top: 15px;" class="tx-list">
                <div class="row justify-center">
                    <div v-for="item in tx_list" :key="item.service_node_pubkey">
                        <div class="col-2" style="padding: 15px; margin-left: auto; margin-right: auto;">
                        <div
                            style="background-color: #222222; border-radius: 5px;margin:5%; padding: 10px">
                            <p class="type" style="color:white">
                                Oracle Node ID: {{ item.service_node_pubkey.substring(0, 4) }}...{{ item.service_node_pubkey.substring(item.service_node_pubkey.length-5, item.service_node_pubkey.length-1) }}
                            </p>
                            <p class="main" style="color:white">
                                Amount Staked: {{
                                    (item.total_contributed / 10000).toLocaleString()
                                }}/{{ (item.staking_requirement / 10000).toLocaleString() }}
                            </p>
                            <q-field class="q-pt-sm">
                                <q-btn style="background-color: #14afde"
                                       class="send-btn"
                                       color="positive"
                                       @click="handleClick(item.service_node_pubkey, item.operator_address, (item.staking_requirement - item.total_contributed)/10000)"
                                       label="Join"/>
                            </q-field>
                        </div>
                        <div style="padding-top: 10px"/>
                        </div>
                    </div>
                </div>
            </div>
            <q-modal v-model="openedSend" minimized content-css="padding: 0 2rem 2rem 2rem" class="confirmBtn">
                <h5>CONFIRM AMOUNT TO STAKE</h5>
                <p>Oracle ID: {{ oracleKey }}</p>
                <p>Max Amount: {{ maxAmount }}</p>
                <tritonField label="Amount">
                    <q-input
                        v-model="newTx.amount"
                        type="number"
                        min="0"
                        :max="maxAmount"
                        placeholder="0"
                        hide-underline
                    />
                </tritonField>
                <div style="margin-left: auto; margin-right: auto;padding-top: 10px">
                    <q-btn
                        style="background-color: #14afde"
                        class="send-btn"
                        color="positive" @click="send()" label="Confirm Stake"/>
                </div>
            </q-modal>

        </div>
    </q-page>
</template>

<script>
import { mapState } from "vuex"
import TxList from "components/pools_list"
import tritonField from "components/triton_field"
import WalletPassword from "../../mixins/wallet_password"

export default {
    data () {
        return {
            tx_type: "all",
            tx_txid: "",
            status: "Not Joined",
            openedSend: false,
            oracleKey: "",
            oracleAddress: "",
            maxAmount: "",
            newTx: {
                amount: 0,
                address: "",
                payment_id: "",
                priority: 0,
                currency: 0,
                address_book: {
                    save: false,
                    name: "",
                    description: ""
                }
            },
            tx_type_options: [
                { label: "All", value: "all" },
                { label: "Incoming", value: "in" },
                { label: "Outgoing", value: "out" },
                { label: "Pending", value: "all_pending" },
                { label: "Miner", value: "miner" },
                { label: "Service Node", value: "snode" },
                { label: "Stake", value: "stake" },
                { label: "Failed", value: "failed" },
            ]

        }
    },
    computed: mapState({
        theme: state => state.gateway.app.config.appearance.theme,
        tx_list: state => state.gateway.wallet.pools.pool_list,
        unlocked_balance: state => state.gateway.wallet.info.unlocked_balance,

    }),

    components: {
        TxList,
        tritonField
    },

    methods: {
        handleClick: function (key, address, maxAmount) {
            this.oracleKey = key
            this.oracleAddress = address
            this.maxAmount = maxAmount
            this.openedSend = true
        },
        send: function () {
            this.openedSend = false
            this.$v.newTx.$touch()

            if (this.newTx.amount < 0) {
                this.$q.notify({
                    type: "negative",
                    timeout: 1000,
                    message: "Amount cannot be negative"
                })
                return
            } else if (this.newTx.amount == 0) {
                this.$q.notify({
                    type: "negative",
                    timeout: 1000,
                    message: "Amount must be greater than zero"
                })
                return
            } else if (this.newTx.amount > this.unlocked_balance / 1e4) {
                this.$q.notify({
                    type: "negative",
                    timeout: 1000,
                    message: "Not enough unlocked balance"
                })
                return
            } else if (this.newTx.amount > this.maxAmount / 1e4) {
                this.$q.notify({
                    type: "negative",
                    timeout: 1000,
                    message: "Amount would cause the staked amount to be greater than the pool max"
                })
                return
            } else if (this.$v.newTx.amount.$error) {
                this.$q.notify({
                    type: "negative",
                    timeout: 1000,
                    message: "Amount not valid"
                })
                return
            }

            if (this.$v.newTx.address.$error) {
                this.$q.notify({
                    type: "negative",
                    timeout: 1000,
                    message: "Address not valid"
                })
                return
            }

            this.showPasswordConfirmation({
                title: "Transfer",
                noPasswordMessage: "Do you want to send the transaction?",
                ok: {
                    label: "SEND",
                    color: "positive"

                },
            }).then(password => {
                this.$store.commit("gateway/set_tx_status", {
                    code: 1,
                    message: "Sending transaction",
                    sending: true
                })
                const newTx = objectAssignDeep.noMutate(this.newTx, { password })
                this.$gateway.send("wallet", "transfer", newTx)
            }).catch(() => {
            })
        }
    },
    mixins: [WalletPassword]

}
</script>

<style lang="scss">
</style>
