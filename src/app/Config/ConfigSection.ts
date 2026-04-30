import Config from '.';

export type ChangeCallback<T = any> = (newValue: T) => void;
export type ChangeRemover = () => void;

type CallbackSet = Set<ChangeCallback>;

export default class ConfigSection {
	private _callbacks: Map<string, CallbackSet> = new Map();

	constructor(private config: Config) {
	}

	onChange<T = any>(key: string, callback: ChangeCallback<T>): ChangeRemover {
		let callbacks = this._callbacks.get(key);

		if (!callbacks) {
			callbacks = new Set();
			this._callbacks.set(key, callbacks);
		}

		const storedCallback = callback as ChangeCallback;
		callbacks.add(storedCallback);

		// Mutable captured refs so the remover can release everything after use.
		let section: ConfigSection | undefined = this;
		let removeKey: string | undefined = key;
		let removeCallback: ChangeCallback | undefined = storedCallback;

		return () => {
			if (!section || removeKey === undefined || !removeCallback) {
				return;
			}

			section.removeOnChange(removeKey, removeCallback);

			// Critical: break remover -> callback -> owner graph.
			section = undefined;
			removeKey = undefined;
			removeCallback = undefined;
		};
	}

	removeOnChange<T = any>(key: string, callback: ChangeCallback<T>): void {
		const callbacks = this._callbacks.get(key);
		if (!callbacks) return;

		callbacks.delete(callback as ChangeCallback);

		if (callbacks.size === 0) {
			this._callbacks.delete(key);
		}
	}

	public static createRemover(
		...removers: readonly (ChangeRemover | undefined)[]
	): ChangeRemover {
		let removed = false;

		// Copy into mutable storage so we can clear it after removal.
		let list: (ChangeRemover | undefined)[] | undefined = removers.slice();

		return () => {
			if (removed) return;
			removed = true;

			const current = list;
			list = undefined;

			if (!current) return;

			for (let i = 0; i < current.length; i++) {
				const remover = current[i];

				// Clear before calling. This helps even if remover throws.
				current[i] = undefined;

				remover?.();
			}

			current.length = 0;
		};
	}

	emitChange<T = any>(key: string, newValue: T): Promise<any[]> {
		this.config.saveSettings();

		const callbacks = this._callbacks.get(key);
		if (!callbacks) return Promise.resolve([]);

		// Snapshot is temporary, but it retains callbacks until all scheduled callbacks finish.
		const snapshot = Array.from(callbacks);

		return Promise.all(
			snapshot.map(
				(callback) =>
					new Promise((resolve, reject) => {
						queueMicrotask(() => {
							try {
								callback(newValue);
								resolve(undefined);
							} catch (error) {
								reject(error);
							}
						});
					})
			)
		).finally(() => {
			// Release snapshot slots as soon as emit completes.
			snapshot.length = 0;
		});
	}

	jsonify() {
	}
}