import child_process from "child_process"

const request = require("request-promise")
const queue = require("promise-queue")
const http = require("http")
const os = require("os")
const fs = require("fs-extra")
const path = require("upath")
const crypto = require("crypto")
const portscanner = require("portscanner")

export class WalletRPC {
    constructor(backend) {
        this.backend = backend
        this.data_dir = null
        this.wallet_dir = null
        this.auth = []
        this.id = 0
        this.net_type = "mainnet"
        this.heartbeat = null
        this.height_check = {
            address: 0,
            pools: 0,
            stake: 0,
            txs: 0
        }
        this.confirmed_stake = false
        this.cancel_stake = false
        this.wallet_state = {
            open: false,
            name: "",
            password_hash: null,
            balance: null,
            unlocked_balance: null
        }
        this.dirs = null
        this.last_height_send_time = Date.now()

        this.height_regex1 = /Processed block: <([a-f0-9]+)>, height (\d+)/
        this.height_regex2 = /Skipped block by height: (\d+)/
        this.height_regex3 = /Skipped block by timestamp, height: (\d+)/
        this.height_regexes = [
            {
                string: /Processed block: <([a-f0-9]+)>, height (\d+)/,
                height: (match) => match[2]
            },
            {
                string: /Skipped block by height: (\d+)/,
                height: (match) => match[1]
            },
            {
                string: /Skipped block by timestamp, height: (\d+)/,
                height: (match) => match[1]
            },
            {
                string: /Blockchain sync progress: <([a-f0-9]+)>, height (\d+)/,
                height: (match) => match[2]
            }
        ]

        this.agent = new http.Agent({keepAlive: true, maxSockets: 1})
        this.queue = new queue(1, Infinity)
    }

    // this function will take an options object for testnet, data-dir, etc
    start(options) {
        const {net_type} = options.app
        const daemon = options.daemons[net_type]
        return new Promise((resolve, reject) => {
            let daemon_address = `${daemon.rpc_bind_ip}:${daemon.rpc_bind_port}`
            if (daemon.type == "remote") {
                daemon_address = `${daemon.remote_host}:${daemon.remote_port}`
            }

            crypto.randomBytes(64 + 64 + 32, (err, buffer) => {
                if (err) throw err

                let auth = buffer.toString("hex")

                this.auth = [
                    auth.substr(0, 64), // rpc username
                    auth.substr(64, 64), // rpc password
                    auth.substr(128, 32) // password salt
                ]

                const args = [
                    "--rpc-login", this.auth[0] + ":" + this.auth[1],
                    "--rpc-bind-port", options.wallet.rpc_bind_port,
                    "--daemon-address", daemon_address,
                    // "--log-level", options.wallet.log_level,
                    "--log-level", "*:WARNING,net*:FATAL,net.http:DEBUG,global:INFO,verify:FATAL,stacktrace:INFO"
                ]

                const {net_type, wallet_data_dir, data_dir} = options.app
                this.net_type = net_type
                this.data_dir = data_dir
                this.wallet_data_dir = wallet_data_dir

                this.dirs = {
                    "mainnet": this.wallet_data_dir,
                    "stagenet": path.join(this.wallet_data_dir, "stagenet"),
                    "testnet": path.join(this.wallet_data_dir, "testnet")
                }

                this.wallet_dir = path.join(this.dirs[net_type], "wallets")
                args.push("--wallet-dir", this.wallet_dir)

                const log_file = path.join(this.dirs[net_type], "logs", "wallet-rpc.log")
                args.push("--log-file", log_file)

                if (net_type === "testnet") {
                    args.push("--testnet")
                } else if (net_type === "stagenet") {
                    args.push("--stagenet")
                }

                if (fs.existsSync(log_file)) {
                    fs.truncateSync(log_file, 0)
                }

                if (!fs.existsSync(this.wallet_dir)) {
                    fs.mkdirpSync(this.wallet_dir)
                }

                if (process.platform === "win32") {
                    this.walletRPCProcess = child_process.spawn(path.join(__ryo_bin, "wallet-rpc.exe"), args)
                } else {
                    this.walletRPCProcess = child_process.spawn(path.join(__ryo_bin, "wallet-rpc"), args, {
                        detached: true
                    })
                }

                // save this info for later RPC calls
                this.protocol = "http://"
                this.hostname = "127.0.0.1"
                this.port = options.wallet.rpc_bind_port

                const rpcExecutable = process.platform === "win32" ? "wallet-rpc.exe" : "wallet-rpc"
                // eslint-disable-next-line no-undef
                const rpcPath = path.join(__ryo_bin, rpcExecutable)

                // Check if the rpc exists
                if (!fs.existsSync(rpcPath)) {
                    reject(new Error("Failed to find XEQ Wallet RPC. Please make sure you anti-virus has not removed it."))
                    return
                }

                portscanner
                    .checkPortStatus(this.port, this.hostname)
                    .catch(() => "closed")
                    .then(status => {
                        if (status === "closed") {
                            const options =
                                process.platform === "win32" ? {} : {detached: true};
                            this.walletRPCProcess = child_process.spawn(
                                rpcPath,
                                args,
                                options
                            );

                            this.walletRPCProcess.stdout.on("data", data => {
                                process.stdout.write(`Wallet: ${data}`);

                                let lines = data.toString().split("\n");
                                let match,
                                    height = null;
                                let isRPCSyncing = false;
                                for (const line of lines) {
                                    for (const regex of this.height_regexes) {
                                        match = line.match(regex.string);
                                        if (match) {
                                            height = regex.height(match);
                                            isRPCSyncing = true;
                                            break;
                                        }
                                    }
                                }

                                // Keep track on wether a wallet is syncing or not
                                this.sendGateway("set_wallet_data", {
                                    isRPCSyncing
                                });
                                this.isRPCSyncing = isRPCSyncing;

                                if (height && Date.now() - this.last_height_send_time > 1000) {
                                    this.last_height_send_time = Date.now();
                                    this.sendGateway("set_wallet_data", {
                                        info: {
                                            height
                                        }
                                    });
                                }
                            });
                            this.walletRPCProcess.on("error", err =>
                                process.stderr.write(`Wallet: ${err}`)
                            );
                            this.walletRPCProcess.on("close", code => {
                                process.stderr.write(`Wallet: exited with code ${code} \n`);
                                this.walletRPCProcess = null;
                                this.agent.destroy();
                                if (code === null) {
                                    reject(new Error("Failed to start wallet RPC"));
                                }
                            });

                            // To let caller know when the wallet is ready
                            let intrvl = setInterval(() => {
                                this.sendRPC("get_languages").then(data => {
                                    if (!data.hasOwnProperty("error")) {
                                        clearInterval(intrvl);
                                        resolve();
                                    } else {
                                        if (
                                            this.walletRPCProcess &&
                                            data.error.cause &&
                                            data.error.cause.code === "ECONNREFUSED"
                                        ) {
                                            // Ignore
                                        } else {
                                            clearInterval(intrvl);
                                            if (this.walletRPCProcess) this.walletRPCProcess.kill();
                                            this.walletRPCProcess = null;
                                            reject(new Error("Could not connect to wallet RPC"));
                                        }
                                    }
                                });
                            }, 1000);
                        } else {
                            reject(new Error(`Wallet RPC port ${this.port} is in use`));
                        }
                    });
            });
        });
    }

    handle(data) {
        let params = data.data

        switch (data.method) {
            case "has_password":
                this.hasPassword()
                break

            case "validate_address":
                this.validateAddress(params.address)
                break

            case "copy_old_gui_wallets":
                this.copyOldGuiWallets(params.wallets || [])
                break

            case "list_wallets":
                this.listWallets()
                break

            case "create_wallet":
                this.createWallet(params.name, params.password, params.language)
                break

            case "restore_wallet":
                this.restoreWallet(params.name, params.password, params.seed,
                    params.refresh_type, params.refresh_type == "date" ? params.refresh_start_date : params.refresh_start_height)
                break

            case "restore_view_wallet":
                // TODO: Decide if we want this for triton
                this.restoreViewWallet(params.name, params.password, params.address, params.viewkey,
                    params.refresh_type, params.refresh_type == "date" ? params.refresh_start_date : params.refresh_start_height)
                break

            case "import_wallet":
                this.importWallet(params.name, params.password, params.path)
                break

            case "open_wallet":
                this.openWallet(params.name, params.password)
                break

            case "close_wallet":
                this.closeWallet()
                break

            case "stake":
                this.stake(params.password, params.amount, params.key, params.destination)
                break
            case "stake_confirm":
                this.confirmStake()
                break
            case "stake_cancel":
                this.cancelStake()
                break
            case "sweepAll":
                this.sweepAll(params.password)
                break;

            case "register_service_node":
                this.registerSnode(params.password, params.string)
                break

            case "unlock_stake":
                this.unlockStake(params.password, params.service_node_key, params.confirmed || false)
                break

            case "transfer":
                this.transfer(params.password, params.amount, params.address, params.payment_id, params.priority, params.currency, params.note || "", params.address_book, params.memo || "", params.network || 0)
                break

            case "swap":
                this.transfer(params.password, params.amount, params.address, params.payment_id, params.priority, params.currency, params.note || "", params.address_book, params.memo, params.network || 0)
                break

            case "add_address_book":
                this.addAddressBook(params.address, params.payment_id,
                    params.description, params.name, params.starred,
                    params.hasOwnProperty("index") ? params.index : false
                )
                break

            case "delete_address_book":
                this.deleteAddressBook(params.hasOwnProperty("index") ? params.index : false)
                break

            case "save_tx_notes":
                this.saveTxNotes(params.txid, params.note)
                break

            case "rescan_blockchain":
                this.rescanBlockchain()
                break
            case "rescan_spent":
                this.rescanSpent()
                break
            case "get_private_keys":
                this.getPrivateKeys(params.password)
                break
            case "export_key_images":
                this.exportKeyImages(params.password, params.path)
                break
            case "import_key_images":
                this.importKeyImages(params.password, params.path)
                break

            case "change_wallet_password":
                this.changeWalletPassword(params.old_password, params.new_password)
                break

            case "delete_wallet":
                this.deleteWallet(params.password)
                break

            default:
        }
    }

    isValidPasswordHash(password_hash) {
        if (this.wallet_state.password_hash === null) return true
        return this.wallet_state.password_hash === password_hash.toString("hex")
    }

    hasPassword() {
        if (this.wallet_state.password_hash === null) {
            this.sendGateway("set_has_password", false)
            return
        }

        crypto.pbkdf2("", this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("set_has_password", false)
                return
            }

            // If the pass hash doesn't match empty string then we don't have a password
            this.sendGateway("set_has_password", this.wallet_state.password_hash !== password_hash.toString("hex"))
        })
    }

    validateAddress(address) {
        this.sendRPC("validate_address", {
            address
        }).then((data) => {
            if (data.hasOwnProperty("error")) {
                this.sendGateway("set_valid_address", {
                    address,
                    valid: false
                })
                return
            }

            const {valid, nettype} = data.result

            const netMatches = this.net_type === nettype
            const isValid = valid && netMatches

            this.sendGateway("set_valid_address", {
                address,
                valid: isValid,
                nettype
            })
        })
    }

    createWallet(filename, password, language) {
        // Reset the status error
        this.sendGateway("reset_wallet_error")
        this.sendRPC("create_wallet", {
            filename,
            password,
            language
        }).then((data) => {
            if (data.hasOwnProperty("error")) {
                this.sendGateway("set_wallet_error", {status: data.error})
                return
            }

            // store hash of the password so we can check against it later when requesting private keys, or for sending txs
            this.wallet_state.password_hash = crypto.pbkdf2Sync(password, this.auth[2], 1000, 64, "sha512").toString("hex")
            this.wallet_state.name = filename
            this.wallet_state.open = true

            this.finalizeNewWallet(filename)
        })
    }

    restoreWallet(filename, password, seed, refresh_type, refresh_start_timestamp_or_height) {
        if (refresh_type == "date") {
            // Convert timestamp to 00:00 and move back a day
            // Core code also moved back some amount of blocks
            let timestamp = refresh_start_timestamp_or_height
            timestamp = timestamp - (timestamp % 86400000) - 86400000

            this.sendGateway("reset_wallet_error")
            this.backend.daemon.timestampToHeight(timestamp).then((height) => {
                if (height === false) {
                    this.sendGateway("set_wallet_error", {status: {code: -1, message: "Invalid restore date"}})
                } else {
                    this.restoreWallet(filename, password, seed, "height", height)
                }
            })
            return
        }

        let restore_height = refresh_start_timestamp_or_height

        if (!Number.isInteger(restore_height)) {
            restore_height = 0
        }
        seed = seed.trim().replace(/\s{2,}/g, " ")

        this.sendGateway("reset_wallet_error")
        this.sendRPC("restore_deterministic_wallet", {
            filename,
            password,
            seed,
            restore_height
        }).then((data) => {
            if (data.hasOwnProperty("error")) {
                this.sendGateway("set_wallet_error", {status: data.error})
                return
            }

            // store hash of the password so we can check against it later when requesting private keys, or for sending txs
            this.wallet_state.password_hash = crypto.pbkdf2Sync(password, this.auth[2], 1000, 64, "sha512").toString("hex")
            this.wallet_state.name = filename
            this.wallet_state.open = true

            this.finalizeNewWallet(filename)
        })
    }

    restoreViewWallet(filename, password, address, viewkey, refresh_type, refresh_start_timestamp_or_height) {
        if (refresh_type == "date") {
            // Convert timestamp to 00:00 and move back a day
            // Core code also moved back some amount of blocks
            let timestamp = refresh_start_timestamp_or_height
            timestamp = timestamp - (timestamp % 86400000) - 86400000

            this.backend.daemon.timestampToHeight(timestamp).then((height) => {
                if (height === false) {
                    this.sendGateway("set_wallet_error", {status: {code: -1, message: "Invalid restore date"}})
                } else {
                    this.restoreViewWallet(filename, password, address, viewkey, "height", height)
                }
            })
            return
        }

        let refresh_start_height = refresh_start_timestamp_or_height

        if (!Number.isInteger(refresh_start_height)) {
            refresh_start_height = 0
        }

        this.sendRPC("restore_view_wallet", {
            filename,
            password,
            address,
            viewkey,
            refresh_start_height
        }).then((data) => {
            if (data.hasOwnProperty("error")) {
                this.sendGateway("set_wallet_error", {status: data.error})
                return
            }

            // store hash of the password so we can check against it later when requesting private keys, or for sending txs
            this.wallet_state.password_hash = crypto.pbkdf2Sync(password, this.auth[2], 1000, 64, "sha512").toString("hex")
            this.wallet_state.name = filename
            this.wallet_state.open = true

            this.finalizeNewWallet(filename)
        })
    }

    importWallet(filename, password, import_path) {
        // Reset the status error
        this.sendGateway("reset_wallet_error")

        // trim off suffix if exists
        if (import_path.endsWith(".keys")) {
            import_path = import_path.substring(0, import_path.length - ".keys".length)
        } else if (import_path.endsWith(".address.txt")) {
            import_path = import_path.substring(0, import_path.length - ".address.txt".length)
        }

        if (!fs.existsSync(import_path)) {
            this.sendGateway("set_wallet_error", {status: {code: -1, message: "Invalid wallet path"}})
        } else {
            let destination = path.join(this.wallet_dir, filename)

            if (fs.existsSync(destination) || fs.existsSync(destination + ".keys")) {
                this.sendGateway("set_wallet_error", {
                    status: {
                        code: -1,
                        message: "Wallet with name already exists"
                    }
                })
                return
            }

            try {
                fs.copySync(import_path, destination, fs.constants.COPYFILE_EXCL)

                if (fs.existsSync(import_path + ".keys")) {
                    fs.copySync(import_path + ".keys", destination + ".keys", fs.constants.COPYFILE_EXCL)
                }
            } catch (e) {
                this.sendGateway("set_wallet_error", {status: {code: -1, message: "Failed to copy wallet"}})
                return
            }

            this.sendRPC("open_wallet", {
                filename,
                password
            }).then((data) => {
                if (data.hasOwnProperty("error")) {
                    if (fs.existsSync(destination)) fs.unlinkSync(destination)
                    if (fs.existsSync(destination + ".keys")) fs.unlinkSync(destination + ".keys")

                    this.sendGateway("set_wallet_error", {status: data.error})
                    return
                }

                // store hash of the password so we can check against it later when requesting private keys, or for sending txs
                this.wallet_state.password_hash = crypto.pbkdf2Sync(password, this.auth[2], 1000, 64, "sha512").toString("hex")
                this.wallet_state.name = filename
                this.wallet_state.open = true

                this.finalizeNewWallet(filename)
            }).catch(() => {
                this.sendGateway("set_wallet_error", {status: {code: -1, message: "An unknown error occured"}})
            })
        }
    }

    finalizeNewWallet(filename) {
        Promise.all([
            this.sendRPC("get_address"),
            this.sendRPC("getheight"),
            this.sendRPC("getbalance", {account_index: 0}),
            this.sendRPC("query_key", {key_type: "mnemonic"}),
            this.sendRPC("query_key", {key_type: "spend_key"}),
            this.sendRPC("query_key", {key_type: "view_key"})
        ]).then((data) => {
            let wallet = {
                info: {
                    name: filename,
                    address: "",
                    balance: 0,
                    unlocked_balance: 0,
                    height: 0,
                    view_only: false
                },
                secret: {
                    mnemonic: "",
                    spend_key: "",
                    view_key: ""
                }
            }
            for (let n of data) {
                if (n.hasOwnProperty("error") || !n.hasOwnProperty("result")) {
                    continue
                }
                if (n.method == "get_address") {
                    wallet.info.address = n.result.address
                } else if (n.method == "getheight") {
                    wallet.info.height = n.result.height
                } else if (n.method == "getbalance") {
                    wallet.info.balance = n.result.balance
                    wallet.info.unlocked_balance = n.result.unlocked_balance
                } else if (n.method == "query_key") {
                    wallet.secret[n.params.key_type] = n.result.key
                    if (n.params.key_type == "spend_key") {
                        if (/^0*$/.test(n.result.key)) {
                            wallet.info.view_only = true
                        }
                    }
                }
            }

            this.saveWallet().then(() => {
                let address_txt_path = path.join(this.wallet_dir, filename + ".address.txt")
                if (!fs.existsSync(address_txt_path)) {
                    fs.writeFile(address_txt_path, wallet.info.address, "utf8", () => {
                        this.listWallets()
                    })
                } else {
                    this.listWallets()
                }
            })

            this.sendGateway("set_wallet_data", wallet)

            this.startHeartbeat()
        })
    }

    openWallet(filename, password) {
        this.sendGateway("reset_wallet_error")
        this.sendRPC("open_wallet", {
            filename,
            password
        }).then((data) => {
            if (data.hasOwnProperty("error")) {
                console.log("ERROR OPEN")
                this.sendGateway("set_wallet_error", {status: data.error})
                return
            }

            let address_txt_path = path.join(this.wallet_dir, filename + ".address.txt")
            if (!fs.existsSync(address_txt_path)) {
                this.sendRPC("get_address", {account_index: 0}).then((data) => {
                    if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                        return
                    }
                    fs.writeFile(address_txt_path, data.result.address, "utf8", () => {
                        this.listWallets()
                    })
                })
            }

            // store hash of the password so we can check against it later when requesting private keys, or for sending txs
            this.wallet_state.password_hash = crypto.pbkdf2Sync(password, this.auth[2], 1000, 64, "sha512").toString("hex")
            this.wallet_state.name = filename
            this.wallet_state.open = true

            this.height_check = {
                address: 0,
                pools: 0,
                stake: 0,
                txs: 0
            }
            this.startHeartbeat()

            // Check if we have a view only wallet by querying the spend key
            this.sendRPC("query_key", {key_type: "spend_key"}).then((data) => {
                if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    return
                }
                if (/^0*$/.test(data.result.key)) {
                    this.sendGateway("set_wallet_data", {
                        info: {
                            view_only: true
                        }
                    })
                }
            })
        })
    }

    startHeartbeat() {
        clearInterval(this.heartbeat)
        this.heartbeat = setInterval(() => {
            this.heartbeatAction()
        }, 5000)
        this.heartbeatAction(true)
    }

    heartbeatAction(extended = false) {
        Promise.all([
            this.sendRPC("get_address", {account_index: 0}, 5000),
            this.sendRPC("getheight", {}, 5000),
            this.sendRPC("getbalance", {account_index: 0}, 5000),
        ]).then((data) => {
            let didError = false
            let wallet = {
                status: {
                    code: 0,
                    message: "OK"
                },
                info: {
                    name: this.wallet_state.name
                },
                transactions: {
                    tx_list: []
                },
                pools: {
                    pool_list: []
                },
                staker: {},
                address_list: {
                    primary: [],
                    used: [],
                    unused: [],
                    address_book: [],
                    address_book_starred: []
                }

            }
            for (let n of data) {
                if (n.hasOwnProperty("error") || !n.hasOwnProperty("result")) {
                    if (extended && n.error && n.error.code === -13) {
                        didError = true
                    }
                    continue
                }

                if (n.method == "getheight") {
                    wallet.info.height = n.result.height
                    this.sendGateway("set_wallet_data", {
                        info: {
                            height: n.result.height
                        }
                    })
                } else if (n.method == "get_address") {
                    wallet.info.address = n.result.address
                    this.sendGateway("set_wallet_data", {
                        info: {
                            address: n.result.address
                        }
                    })
                } else if (n.method == "getbalance") {
                    if (this.wallet_state.balance == n.result.balance &&
                        this.wallet_state.unlocked_balance == n.result.unlocked_balance) {
                        // continue
                    }

                    this.wallet_state.balance = wallet.info.balance = n.result.balance
                    this.wallet_state.unlocked_balance = wallet.info.unlocked_balance = n.result.unlocked_balance
                    this.sendGateway("set_wallet_data", {
                        info: wallet.info
                    })

                    // if balance has recently changed, get updated list of transactions and used addresses
                    let actions = [
                        this.getTransactions(wallet.info.height),
                        this.getAddressList(wallet.info.height),
                        this.getPools(wallet.info.height),
                        this.getStake(wallet.info.address, wallet.info.height)
                    ]

                    if (true || extended) {
                        actions.push(this.getAddressBook())
                    }
                    Promise.all(actions).then((data) => {
                        for (let n of data) {
                            Object.keys(n).map(key => {
                                wallet[key] = Object.assign(wallet[key], n[key])
                            })
                        }
                        this.sendGateway("set_wallet_data", wallet)
                    })
                }
            }

            // Set the wallet state on initial heartbeat
            if (extended) {
                if (!didError) {
                    this.sendGateway("set_wallet_data", wallet)
                } else {
                    this.closeWallet().then(() => {
                        this.sendGateway("set_wallet_error", {
                            status: {
                                code: -1,
                                message: "Failed to open wallet. Please try again."
                            }
                        })
                    })
                }
            }
        })
    }

    confirmStake() {
        this.confirmed_stake = true
    }

    cancelStake() {
        this.cancel_stake = true
    }

    stake(password, amount, service_node_key, destination) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("show_notification", {
                    type: "negative",
                    message: "Password Error",
                    timeout: 2000
                })
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("show_notification", {
                    type: "negative",
                    message: "Password Error",
                    timeout: 2000
                })
                return
            }


            amount = parseFloat(amount).toFixed(4) * 1e4
            this.sendRPC("stake", {
                amount,
                destination,
                service_node_key,
                do_not_relay: true,
                get_tx_metadata: true
            }).then(async (data) => {
                if (data.hasOwnProperty("error")) {
                    let error = data.error.message.charAt(0).toUpperCase() + data.error.message.slice(1)
                    this.sendGateway("show_notification", {
                        type: "negative",
                        message: error,
                        timeout: 2000
                    })
                    this.sendGateway("set_tx_status", {
                        code: -1,
                        message: error,
                        sending: false
                    })
                    return
                }

                if (data.result) {
                    let burn = (amount / 1e4) * .001
                    let fee = (data.result.fee / 1e4) - burn
                    this.sendGateway("set_tx_status", {
                        code: 0,
                        message: "Fee " + (fee).toLocaleString() + " | Burn: " + (burn).toLocaleString(),
                        sending: false
                    })
                    while (!this.confirmed_stake) {
                        await new Promise(r => setTimeout(r, 25));
                        if (this.cancel_stake) {
                            this.sendGateway("show_notification", {
                                type: "negative",
                                message: "User canceled tx",
                                timeout: 2000
                            })
                            this.confirmed_stake = false
                            this.cancel_stake = false
                            return
                        }
                    }
                    this.confirmed_stake = false
                    this.cancel_stake = false

                    this.sendRPC("relay_tx", {"hex": data.result.tx_metadata}).then((data_finalize) => {
                        if (data.hasOwnProperty("error")) {
                            let error = data.error.message.charAt(0).toUpperCase() + data.error.message.slice(1)
                            this.sendGateway("set_tx_status", {
                                code: -1,
                                message: error,
                                sending: false
                            })
                            return
                        }

                        this.sendGateway("show_notification", {
                            type: "positive",
                            message: "Staked " + (amount / 1e4).toLocaleString() + " XEQ to: " + service_node_key,
                            timeout: 2000
                        })

                        this.sendGateway("set_tx_status", {
                            code: 0,
                            sending: true
                        })
                    })
                }

            })
        })
    }

    sweepAll(password) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("set_tx_status", {
                    code: -1,
                    message: "Internal error",
                    sending: false
                })
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("set_tx_status", {
                    code: -1,
                    message: "Invalid password",
                    sending: false
                })
                return
            }


            this.sendRPC("get_address", {account_index: 0}).then((data) => {
                if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    return
                }

                let my_address = data.result.address

                let amount = this.wallet_state.unlocked_balance

                let sweep_all = amount == this.wallet_state.unlocked_balance

                const rpc_endpoint = sweep_all ? "sweep_all" : "transfer_split"
                const params = {
                    "address": my_address,
                    "account_index": 0,
                    "priority": 0,
                    "ring_size": 15 // Always force a ring size of 10 (ringsize = mixin + 1)
                }

                this.sendRPC(rpc_endpoint, params).then((data) => {
                    if (data.hasOwnProperty("error")) {
                        let error = data.error.message.charAt(0).toUpperCase() + data.error.message.slice(1)
                        this.sendGateway("set_tx_status", {
                            code: -1,
                            message: error,
                            sending: false
                        })
                        return
                    }

                    this.sendGateway("set_tx_status", {
                        code: 0,
                        message: "Sweep All Successfully sent",
                        sending: false
                    })

                    if (data.result) {
                        const hash_list = data.result.tx_hash_list || []
                        // Save notes
                        if (note && note !== "") {
                            hash_list.forEach(txid => this.saveTxNotes(txid, note))
                        }
                    }
                })
            })
        })
    }

    transfer(password, amount, address, payment_id, priority, currency, note, address_book = {}, memo, network) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("set_tx_status", {
                    code: -1,
                    message: "Internal error",
                    sending: false
                })
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("set_tx_status", {
                    code: -1,
                    message: "Invalid password",
                    sending: false
                })
                return
            }

            amount = parseFloat(amount).toFixed(4) * 1e4

            let sweep_all = amount == this.wallet_state.unlocked_balance

            const rpc_endpoint = sweep_all ? "sweep_all" : "transfer_split"
            const params = sweep_all ? {
                "address": address,
                "account_index": 0,
                "priority": priority,
                "ring_size": 15 // Always force a ring size of 10 (ringsize = mixin + 1)
            } : {
                "destinations": [{"amount": amount, "address": address}],
                "priority": priority,
                "ring_size": 15
            }

            if (payment_id) {
                params.payment_id = payment_id
            }

            if (memo) {
                let memo_field = {
                    network: 0,
                    address: "",
                    amount: ""
                }
                memo_field.address = memo;
                memo_field.amount = amount.toString()
                memo_field.network = network;
                params.memo = JSON.stringify(memo_field);
            }

            params.do_not_relay = true;
            params.get_tx_metadata = true;

            this.sendRPC(rpc_endpoint, params).then(async (data) => {
                if (data.hasOwnProperty("error")) {
                    let error = data.error.message.charAt(0).toUpperCase() + data.error.message.slice(1)
                    this.sendGateway("set_tx_status", {
                        code: -1,
                        message: error,
                        sending: false
                    })
                    return
                }

                if (data.result) {
                    console.log("Fee: " + data.result.fee_list[0] / 1e4)
                    this.sendGateway("set_tx_status", {
                        code: 0,
                        message: "Fee " + (data.result.fee_list[0] / 1e4).toLocaleString(),
                        sending: false
                    })

                    while (!this.confirmed_stake) {
                        await new Promise(r => setTimeout(r, 25));
                        if (this.cancel_stake) {
                            this.sendGateway("show_notification", {
                                type: "negative",
                                message: "User canceled tx",
                                timeout: 2000
                            })
                            this.confirmed_stake = false
                            this.cancel_stake = false
                            return
                        }
                    }
                    this.confirmed_stake = false
                    this.cancel_stake = false

                    this.sendRPC("relay_tx", {"hex": data.result.tx_metadata_list[0]}).then((data_finalize) => {
                        if (data.hasOwnProperty("error")) {
                            let error = data.error.message.charAt(0).toUpperCase() + data.error.message.slice(1)
                            this.sendGateway("set_tx_status", {
                                code: -1,
                                message: error,
                                sending: false
                            })
                            return
                        }

                        this.sendGateway("set_tx_status", {
                            code: 1,
                            message: "Transaction successfully sent",
                            sending: false
                        })

                        if (data_finalize.result.tx_hash)
                            this.saveTxNotes(data_finalize.result.tx_hash, note)
                    })
                }
            })

            if (address_book.hasOwnProperty("save") && address_book.save) {
                this.addAddressBook(address, payment_id, address_book.description, address_book.name)
            }
        })
    }

    swap(password, amount, address, payment_id, priority, currency, note, address_book = {}) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("set_tx_status", {
                    code: -1,
                    message: "Internal error",
                    sending: false
                })
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("set_tx_status", {
                    code: -1,
                    message: "Invalid password",
                    sending: false
                })
                return
            }

            this.sendRPC("get_address", {account_index: 0}).then((data) => {
                if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    return
                }

                let my_address = data.result.address
                amount = parseFloat(amount).toFixed(4) * 1e4

                let sweep_all = amount == this.wallet_state.unlocked_balance

                const rpc_endpoint = "swap"
                const params = sweep_all ? {
                    "swap_address": address,
                    "account_index": 0,
                    "priority": priority,
                    "ring_size": 15 // Always force a ring size of 10 (ringsize = mixin + 1)
                } : {
                    "swap_address": address,
                    "destinations": [{"amount": amount, "address": my_address}],
                    "priority": priority,
                    "ring_size": 15
                }

                if (payment_id) {
                    params.payment_id = payment_id
                }

                this.sendRPC(rpc_endpoint, params).then((data) => {
                    if (data.hasOwnProperty("error")) {
                        let error = data.error.message.charAt(0).toUpperCase() + data.error.message.slice(1)
                        this.sendGateway("set_tx_status", {
                            code: -1,
                            message: error,
                            sending: false
                        })
                        return
                    }

                    this.sendGateway("set_tx_status", {
                        code: 0,
                        message: "Transaction successfully sent",
                        sending: false
                    })

                    if (data.result) {
                        const hash_list = data.result.tx_hash_list || []
                        // Save notes
                        if (note && note !== "") {
                            hash_list.forEach(txid => this.saveTxNotes(txid, note))
                        }
                    }
                })

            })

            if (address_book.hasOwnProperty("save") && address_book.save) {
                this.addAddressBook(address, payment_id, address_book.description, address_book.name)
            }
        })
    }

    rescanBlockchain() {
        this.sendRPC("rescan_blockchain")
    }

    rescanSpent() {
        this.sendRPC("rescan_spent")
    }

    getPrivateKeys(password) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("set_wallet_data", {
                    secret: {
                        mnemonic: "Internal error",
                        spend_key: -1,
                        view_key: -1
                    }
                })
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("set_wallet_data", {
                    secret: {
                        mnemonic: "Invalid password",
                        spend_key: -1,
                        view_key: -1
                    }
                })
                return
            }
            Promise.all([
                this.sendRPC("query_key", {key_type: "mnemonic"}),
                this.sendRPC("query_key", {key_type: "spend_key"}),
                this.sendRPC("query_key", {key_type: "view_key"})
            ]).then((data) => {
                let wallet = {
                    secret: {
                        mnemonic: "",
                        spend_key: "",
                        view_key: ""
                    }
                }
                for (let n of data) {
                    if (n.hasOwnProperty("error") || !n.hasOwnProperty("result")) {
                        continue
                    }
                    wallet.secret[n.params.key_type] = n.result.key
                }

                this.sendGateway("set_wallet_data", wallet)
            })
        })
    }

    async getAddressList(height) {
        return new Promise(async (resolve, reject) => {
            let check = await this.checkHeight("address", height)
            if (!check) {
                reject()
                return
            }
            Promise.all([
                this.sendRPC("get_address", {account_index: 0}),
                this.sendRPC("getbalance", {account_index: 0})
            ]).then((data) => {
                for (let n of data) {
                    if (n.hasOwnProperty("error") || !n.hasOwnProperty("result")) {
                        resolve({})
                        return
                    }
                }

                let num_unused_addresses = 10

                let wallet = {
                    info: {
                        address: data[0].result.address,
                        balance: data[1].result.balance,
                        unlocked_balance: data[1].result.unlocked_balance
                        // num_unspent_outputs: data[1].result.num_unspent_outputs
                    },
                    address_list: {
                        primary: [],
                        used: [],
                        unused: []
                    }
                }

                for (let address of data[0].result.addresses) {
                    address.balance = null
                    address.unlocked_balance = null
                    address.num_unspent_outputs = null

                    if (data[1].result.hasOwnProperty("per_subaddress")) {
                        for (let address_balance of data[1].result.per_subaddress) {
                            if (address_balance.address_index == address.address_index) {
                                address.balance = address_balance.balance
                                address.unlocked_balance = address_balance.unlocked_balance
                                address.num_unspent_outputs = address_balance.num_unspent_outputs
                                break
                            }
                        }
                    }

                    if (address.address_index == 0) {
                        wallet.address_list.primary.push(address)
                    } else if (address.used) {
                        wallet.address_list.used.push(address)
                    } else {
                        wallet.address_list.unused.push(address)
                    }
                }

                // limit to 10 unused addresses
                wallet.address_list.unused = wallet.address_list.unused.slice(0, 10)

                if (wallet.address_list.unused.length < num_unused_addresses &&
                    !wallet.address_list.primary[0].address.startsWith("RYoK") &&
                    !wallet.address_list.primary[0].address.startsWith("RYoH")) {
                    for (let n = wallet.address_list.unused.length; n < num_unused_addresses; n++) {
                        this.sendRPC("create_address", {account_index: 0}).then((data) => {
                            wallet.address_list.unused.push(data.result)
                            if (wallet.address_list.unused.length == num_unused_addresses) {
                                // should sort them here
                                resolve(wallet)
                            }
                        })
                    }
                } else {
                    resolve(wallet)
                }
            })
        })
    }

    async getPools(height) {
        return new Promise(async (resolve, reject) => {
            let check = await this.checkHeight("pools", height)
            if (!check) {
                reject()
                return
            }
            this.backend.daemon.sendRPC("get_service_nodes")
                .then((data) => {
                    let wallet = {
                        pools: {
                            pool_list: data.result.service_node_states
                        }
                    }
                    resolve(wallet)
                }).catch(
                (error) => {
                    console.log(error)
                }
            )
        })
    }

    async checkHeight(func_name, height) {
        return new Promise(ok => {
            if (this.height_check[func_name] == height) {
                ok(false)
            } else {
                this.height_check[func_name] = height
                ok(true)
            }
        })
    }

    async getStake(address, height) {
        return new Promise(async (resolve, reject) => {
            let check = await this.checkHeight("stake", height)
            if (!check) {
                reject()
                console.log("Skipped Heartbeat")
                return
            }
            this.backend.daemon.sendRPC("on_get_staker", {
                "address": address
            })
                .then((data) => {
                    let wallet = {
                        staker: {
                            stake: data.result
                        }
                    }
                    resolve(wallet)
                }).catch(
                (error) => {
                    console.log(error)
                }
            )
        })
    }

    async getTransactions(height) {
        return new Promise(async (resolve, reject) => {
            let check = await this.checkHeight("txs", height)
            if (!check) {
                reject()
                return
            }
            this.sendRPC("get_transfers", {
                in: true,
                out: true,
                pending: true,
                failed: true,
                pool: true
            }).then((data) => {
                if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    resolve({})
                    return
                }
                let wallet = {
                    transactions: {
                        tx_list: []
                    }
                }

                const types = ["in", "out", "pending", "failed", "pool", "miner", "snode", "gov", "stake"]
                types.forEach(type => {
                    if (data.result.hasOwnProperty(type)) {
                        wallet.transactions.tx_list = wallet.transactions.tx_list.concat(data.result[type])
                    }
                })

                for (let i = 0; i < wallet.transactions.tx_list.length; i++) {
                    if (/^0*$/.test(wallet.transactions.tx_list[i].payment_id)) {
                        wallet.transactions.tx_list[i].payment_id = ""
                    } else if (/^0*$/.test(wallet.transactions.tx_list[i].payment_id.substring(16))) {
                        wallet.transactions.tx_list[i].payment_id = wallet.transactions.tx_list[i].payment_id.substring(0, 16)
                    }
                }

                wallet.transactions.tx_list.sort(function (a, b) {
                    if (a.timestamp < b.timestamp) return 1
                    if (a.timestamp > b.timestamp) return -1
                    return 0
                })
                resolve(wallet)
            })
        })
    }

    getAddressBook() {
        return new Promise((resolve, reject) => {
            this.sendRPC("get_address_book").then((data) => {
                if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    resolve({})
                    return
                }
                let wallet = {
                    address_list: {
                        address_book: [],
                        address_book_starred: []
                    }
                }

                if (data.result.entries) {
                    let i
                    for (i = 0; i < data.result.entries.length; i++) {
                        let entry = data.result.entries[i]
                        let desc = entry.description.split("::")
                        if (desc.length == 3) {
                            entry.starred = desc[0] == "starred"
                            entry.name = desc[1]
                            entry.description = desc[2]
                        } else if (desc.length == 2) {
                            entry.starred = false
                            entry.name = desc[0]
                            entry.description = desc[1]
                        } else {
                            entry.starred = false
                            entry.name = entry.description
                            entry.description = ""
                        }

                        if (/^0*$/.test(entry.payment_id)) {
                            entry.payment_id = ""
                        } else if (/^0*$/.test(entry.payment_id.substring(16))) {
                            entry.payment_id = entry.payment_id.substring(0, 16)
                        }

                        if (entry.starred) {
                            wallet.address_list.address_book_starred.push(entry)
                        } else {
                            wallet.address_list.address_book.push(entry)
                        }
                    }
                }

                resolve(wallet)
            })
        })
    }

    deleteAddressBook(index = false) {
        if (index !== false) {
            this.sendRPC("delete_address_book", {index: index}).then(() => {
                this.saveWallet().then(() => {
                    this.getAddressBook().then((data) => {
                        this.sendGateway("set_wallet_data", data)
                    })
                })
            })
        }
    }

    addAddressBook(address, payment_id = null, description = "", name = "", starred = false, index = false) {
        if (index !== false) {
            this.sendRPC("delete_address_book", {index: index}).then((data) => {
                this.addAddressBook(address, payment_id, description, name, starred)
            })
            return
        }

        let params = {
            address
        }
        if (payment_id != null) {
            params.payment_id = payment_id
        }

        let desc = []
        if (starred) {
            desc.push("starred")
        }
        desc.push(name, description)

        params.description = desc.join("::")

        this.sendRPC("add_address_book", params).then((data) => {
            this.saveWallet().then(() => {
                this.getAddressBook().then((data) => {
                    this.sendGateway("set_wallet_data", data)
                })
            })
        })
    }

    saveTxNotes(txid, note) {
        this.sendRPC("set_tx_notes", {txids: [txid], notes: [note]}).then((data) => {
            this.getTransactions().then((wallet) => {
                this.sendGateway("set_wallet_data", wallet)
            })
        })
    }

    exportKeyImages(password, filename = null) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("show_notification", {type: "negative", message: "Internal error", timeout: 2000})
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("show_notification", {type: "negative", message: "Invalid password", timeout: 2000})
                return
            }

            if (filename == null) {
                filename = path.join(this.wallet_data_dir, "images", this.wallet_state.name, "key_image_export")
            } else {
                filename = path.join(filename, "key_image_export")
            }

            const onError = () => this.sendGateway("show_notification", {
                type: "negative",
                message: "Error exporting key images",
                timeout: 2000
            })

            this.sendRPC("export_key_images").then((data) => {
                if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    onError()
                    return
                }

                if (data.result.signed_key_images) {
                    fs.outputJSONSync(filename, data.result.signed_key_images)
                    this.sendGateway("show_notification", {
                        message: "Key images exported to " + filename,
                        timeout: 2000
                    })
                } else {
                    this.sendGateway("show_notification", {
                        type: "warning",
                        textColor: "black",
                        message: "No key images found to export",
                        timeout: 2000
                    })
                }
            }).catch(onError)
        })
    }

    importKeyImages(password, filename = null) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("show_notification", {type: "negative", message: "Internal error", timeout: 2000})
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("show_notification", {type: "negative", message: "Invalid password", timeout: 2000})
                return
            }

            if (filename == null) {
                filename = path.join(this.wallet_data_dir, "images", this.wallet_state.name, "key_image_export")
            }

            const onError = (message) => this.sendGateway("show_notification", {
                type: "negative",
                message,
                timeout: 2000
            })

            fs.readJSON(filename).then(signed_key_images => {
                this.sendRPC("import_key_images", {signed_key_images}).then((data) => {
                    if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                        onError("Error importing key images")
                        return
                    }

                    this.sendGateway("show_notification", {message: "Key images imported", timeout: 2000})
                })
            }).catch(() => onError("Error reading key images"))
        })
    }

    copyOldGuiWallets(wallets) {
        this.sendGateway("set_old_gui_import_status", {code: 1, failed_wallets: []})

        const failed_wallets = []

        for (const wallet of wallets) {
            const {type, directory} = wallet

            const old_gui_path = path.join(this.wallet_dir, "old-gui")
            const dir_path = path.join(this.wallet_dir, directory)
            const stat = fs.statSync(dir_path)
            if (!stat.isDirectory()) continue

            // Make sure the directory has the regular and keys file
            const wallet_file = path.join(dir_path, directory)
            const key_file = wallet_file + ".keys"

            // If we don't have them then don't bother copying
            if (!(fs.existsSync(wallet_file) && fs.existsSync(key_file))) {
                failed_wallets.push(directory)
                continue
            }

            // Copy out the file into the relevant directory
            const destination = path.join(this.dirs[type], "wallets")
            if (!fs.existsSync(destination)) fs.mkdirpSync(destination)

            const new_path = path.join(destination, directory)

            try {
                // Copy into temp file
                if (fs.existsSync(new_path + ".atom") || fs.existsSync(new_path + ".atom.keys")) {
                    failed_wallets.push(directory)
                    continue
                }

                fs.copyFileSync(wallet_file, new_path + ".atom", fs.constants.COPYFILE_EXCL)
                fs.copyFileSync(key_file, new_path + ".atom.keys", fs.constants.COPYFILE_EXCL)

                // Move the folder into a subfolder
                if (!fs.existsSync(old_gui_path)) fs.mkdirpSync(old_gui_path)
                fs.moveSync(dir_path, path.join(old_gui_path, directory), {overwrite: true})
            } catch (e) {
                // Cleanup the copied files if an error
                if (fs.existsSync(new_path + ".atom")) fs.unlinkSync(new_path + ".atom")
                if (fs.existsSync(new_path + ".atom.keys")) fs.unlinkSync(new_path + ".atom.keys")
                failed_wallets.push(directory)
                continue
            }

            // Rename the imported wallets if we can
            if (!fs.existsSync(new_path) && !fs.existsSync(new_path + ".keys")) {
                fs.renameSync(new_path + ".atom", new_path)
                fs.renameSync(new_path + ".atom.keys", new_path + ".keys")
            }
        }

        this.sendGateway("set_old_gui_import_status", {code: 0, failed_wallets})
        this.listWallets()
    }

    listWallets(legacy = false) {
        let wallets = {
            list: [],
            directories: []
        }

        fs.readdirSync(this.wallet_dir).forEach(filename => {
            switch (filename) {
                case ".DS_Store":
                case ".DS_Store?":
                case "._.DS_Store":
                case ".Spotlight-V100":
                case ".Trashes":
                case "ehthumbs.db":
                case "Thumbs.db":
                case "old-gui":
                    return
            }

            // If it's a directory then check if it's an old gui wallet
            const name = path.join(this.wallet_dir, filename)
            const stat = fs.statSync(name)
            if (stat.isDirectory()) {
                // Make sure the directory has the regular and keys file
                const wallet_file = path.join(name, filename)
                const key_file = wallet_file + ".keys"

                // If we have them then it is an old gui wallet
                if (fs.existsSync(wallet_file) && fs.existsSync(key_file)) {
                    wallets.directories.push(filename)
                }
                return
            }

            if (path.extname(filename) !== "") return

            let wallet_data = {
                name: filename,
                address: null,
                password_protected: null
            }

            if (fs.existsSync(path.join(this.wallet_dir, filename + ".meta.json"))) {
                let meta = fs.readFileSync(path.join(this.wallet_dir, filename + ".meta.json"), "utf8")
                if (meta) {
                    meta = JSON.parse(meta)
                    wallet_data.address = meta.address
                    wallet_data.password_protected = meta.password_protected
                }
            } else if (fs.existsSync(path.join(this.wallet_dir, filename + ".address.txt"))) {
                let address = fs.readFileSync(path.join(this.wallet_dir, filename + ".address.txt"), "utf8")
                if (address) {
                    wallet_data.address = address
                }
            }

            wallets.list.push(wallet_data)
        })

        // Check for legacy wallet files
        if (legacy) {
            wallets.legacy = []
            let legacy_paths = []
            if (os.platform() == "win32") {
                legacy_paths = ["C:\\ProgramData\\equilibria"]
            } else {
                legacy_paths = [path.join(os.homedir(), "equilibria")]
            }
            for (var i = 0; i < legacy_paths.length; i++) {
                let legacy_config_path = path.join(legacy_paths[i], "config", "wallet_info.json")
                if (this.net_type === "test") {
                    legacy_config_path = path.join(legacy_paths[i], "testnet", "config", "wallet_info.json")
                }
                if (!fs.existsSync(legacy_config_path)) {
                    continue
                }

                let legacy_config = JSON.parse(fs.readFileSync(legacy_config_path, "utf8"))
                let legacy_wallet_path = legacy_config.wallet_filepath
                if (!fs.existsSync(legacy_wallet_path)) {
                    continue
                }

                let legacy_address = ""
                if (fs.existsSync(legacy_wallet_path + ".address.txt")) {
                    legacy_address = fs.readFileSync(legacy_wallet_path + ".address.txt", "utf8")
                }
                wallets.legacy.push({path: legacy_wallet_path, address: legacy_address})
            }
        }

        this.sendGateway("wallet_list", wallets)
    }

    changeWalletPassword(old_password, new_password) {
        crypto.pbkdf2(old_password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("show_notification", {type: "negative", message: "Internal error", timeout: 2000})
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("show_notification", {
                    type: "negative",
                    message: "Invalid old password",
                    timeout: 2000
                })
                return
            }

            this.sendRPC("change_wallet_password", {old_password, new_password}).then((data) => {
                if (data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    this.sendGateway("show_notification", {
                        type: "negative",
                        message: "Error changing password",
                        timeout: 2000
                    })
                    return
                }

                // store hash of the password so we can check against it later when requesting private keys, or for sending txs
                this.wallet_state.password_hash = crypto.pbkdf2Sync(new_password, this.auth[2], 1000, 64, "sha512").toString("hex")

                this.sendGateway("show_notification", {message: "Password updated", timeout: 2000})
            })
        })
    }

    deleteWallet(password) {
        crypto.pbkdf2(password, this.auth[2], 1000, 64, "sha512", (err, password_hash) => {
            if (err) {
                this.sendGateway("show_notification", {type: "negative", message: "Internal error", timeout: 2000})
                return
            }
            if (!this.isValidPasswordHash(password_hash)) {
                this.sendGateway("show_notification", {type: "negative", message: "Invalid password", timeout: 2000})
                return
            }

            this.sendGateway("show_loading", {message: "Deleting wallet"})

            let wallet_path = path.join(this.wallet_dir, this.wallet_state.name)
            this.closeWallet().then(() => {
                fs.unlinkSync(wallet_path)
                fs.unlinkSync(wallet_path + ".keys")
                fs.unlinkSync(wallet_path + ".address.txt")

                this.listWallets()
                this.sendGateway("hide_loading")
                this.sendGateway("return_to_wallet_select")
            })
        })
    }

    saveWallet() {
        return new Promise((resolve, reject) => {
            this.sendRPC("store").then(() => {
                resolve()
            })
        })
    }

    closeWallet() {
        return new Promise((resolve, reject) => {
            clearInterval(this.heartbeat)
            this.wallet_state = {
                open: false,
                name: "",
                password_hash: null,
                balance: null,
                unlocked_balance: null
            }

            this.saveWallet().then(() => {
                this.sendRPC("close_wallet").then(() => {
                    resolve()
                })
            })
        })
    }

    sendGateway(method, data) {
        // if wallet is closed, do not send any wallet data to gateway
        // this is for the case that we close the wallet at the same
        // after another action has started, but before it has finished
        if (!this.wallet_state.open && method == "set_wallet_data") {
            return
        }
        this.backend.send(method, data)
    }

    sendRPC(method, params = {}, timeout = 0) {
        let id = this.id++
        let options = {
            uri: `${this.protocol}${this.hostname}:${this.port}/json_rpc`,
            method: "POST",
            json: {
                jsonrpc: "2.0",
                id: id,
                method: method
            },
            auth: {
                user: this.auth[0],
                pass: this.auth[1],
                sendImmediately: false
            },
            agent: this.agent
        }
        if (Object.keys(params).length !== 0) {
            options.json.params = params
        }
        if (timeout > 0) {
            options.timeout = timeout
        }

        return this.queue.add(() => {
            return request(options)
                .then((response) => {
                    if (response.hasOwnProperty("error")) {
                        return {
                            method: method,
                            params: params,
                            error: response.error
                        }
                    }
                    return {
                        method: method,
                        params: params,
                        result: response.result
                    }
                }).catch(error => {
                    return {
                        method: method,
                        params: params,
                        error: {
                            code: -1,
                            message: "Cannot connect to wallet-rpc",
                            cause: error.cause
                        }
                    }
                })
        })
    }

    getRPC(parameter, params = {}) {
        return this.sendRPC(`get_${parameter}`, params)
    }

    quit() {
        return new Promise((resolve, reject) => {
            if (this.walletRPCProcess) {
                this.closeWallet().then(() => {
                    // normally we would exit wallet after this promise
                    // however if the wallet is not responsive to RPC
                    // requests then we must forcefully close it below
                })
                setTimeout(() => {
                    this.walletRPCProcess.on("close", code => {
                        this.agent.destroy()
                        clearTimeout(this.forceKill)
                        resolve()
                    })
                    // Force kill after 20 seconds
                    this.forceKill = setTimeout(() => {
                        this.walletRPCProcess.kill("SIGKILL")
                    }, 20000)

                    // Force kill if the rpc is syncing
                    const signal = this.isRPCSyncing ? "SIGKILL" : "SIGTERM"
                    this.walletRPCProcess.kill(signal)
                }, 2500)
            } else {
                resolve()
            }
        })
    }
}
