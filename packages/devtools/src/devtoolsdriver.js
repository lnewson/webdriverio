import fs from 'fs'
import path from 'path'
import uuidv4 from 'uuid/v4'

import logger from '@wdio/logger'
import { safeRequire } from '@wdio/utils'

import ElementStore from './elementstore'
import { validate, sanitizeError } from './utils'
import { DEFAULT_IMPLICIT_TIMEOUT, DEFAULT_PAGELOAD_TIMEOUT, DEFAULT_SCRIPT_TIMEOUT } from './constants'

const log = logger('devtools')

export default class DevToolsDriver {
    constructor (browser, pages) {
        this.commands = {}
        this.elementStore = new ElementStore()
        this.windows = new Map()
        this.timeouts = new Map()
        this.activeDialog = null
        this.browser = browser

        const dir = path.resolve(__dirname, 'commands')
        const files = fs.readdirSync(dir)
        for (let filename of files) {
            const commandName = path.basename(filename, path.extname(filename))
            this.commands[commandName] = safeRequire(path.join(dir, commandName)).default
        }

        for (const page of pages) {
            const pageId = uuidv4()
            this.windows.set(pageId, page)
            this.currentWindowHandle = pageId
        }

        /**
         * set default timeouts
         */
        this.setTimeouts(DEFAULT_IMPLICIT_TIMEOUT, DEFAULT_PAGELOAD_TIMEOUT, DEFAULT_SCRIPT_TIMEOUT)

        const page = this.windows.get(this.currentWindowHandle)
        page.on('dialog', ::this.dialogHandler)
        page.on('framenavigated', ::this.framenavigatedHandler)
    }

    /**
     * moved into an extra method for testing purposes
     */
    /* istanbul ignore next */
    static requireCommand (filePath) {
        return require(filePath).default
    }

    register (commandInfo) {
        const self = this
        const { command, ref, parameters, variables = [] } = commandInfo

        /**
         * check if command is implemented
         */
        if (typeof this.commands[command] !== 'function') {
            return () => { throw new Error('Not yet implemented') }
        }

        /**
         * within here you find the webdriver scope
         */
        const wrappedCommand = async function (...args) {
            /**
             * ensure there is no page transition happening and an execution context
             * is available
             */
            const page = self.getPageHandle()
            const executionContext = await page.mainFrame().executionContext()
            try {
                await executionContext.evaluate('1')
            } catch (err) {
                return wrappedCommand.apply(this, args)
            }

            const params = validate(command, parameters, variables, ref, args)
            let result

            try {
                result = await self.commands[command].call(self, params)
            } catch (err) {
                /**
                 * if though we check for an execution context before executing a command we
                 * can technically still run into the situation (especially if the command
                 * contains multiple interaction with the page and is long) where the execution
                 * context gets destroyed. For these cases handle page transitions gracefully
                 * by repeating the command.
                 */
                if (err.message.includes('most likely because of a navigation')) {
                    log.debug('Command failed due to unfinished page transition, retrying...')
                    const page = self.getPageHandle()
                    await new Promise((resolve, reject) => {
                        const pageloadTimeout = setTimeout(
                            () => reject(new Error('page load timeout')),
                            self.timeouts.get('pageLoad'))

                        page.once('load', () => {
                            clearTimeout(pageloadTimeout)
                            resolve()
                        })
                    })
                    return wrappedCommand.apply(this, args)
                }

                throw sanitizeError(err)
            }

            log.info('RESULT', command.toLowerCase().includes('screenshot')
                && typeof result === 'string' && result.length > 64
                ? `${result.substr(0, 61)}...` : result)

            return result
        }

        return wrappedCommand
    }

    dialogHandler (dialog) {
        this.activeDialog = dialog
    }

    framenavigatedHandler (frame) {
        this.currentFrameUrl = frame.url()
        this.elementStore.clear()
    }

    setTimeouts (implicit, pageLoad, script) {
        if (typeof implicit === 'number') {
            this.timeouts.set('implicit', implicit)
        }
        if (typeof pageLoad === 'number') {
            this.timeouts.set('pageLoad', pageLoad)
        }
        if (typeof script === 'number') {
            this.timeouts.set('script', script)
        }

        const page = this.windows.get(this.currentWindowHandle)
        page.setDefaultTimeout(this.timeouts.get('pageLoad'))
    }

    getPageHandle () {
        if (this.currentFrame) {
            return this.currentFrame
        }

        return this.windows.get(this.currentWindowHandle)
    }
}
