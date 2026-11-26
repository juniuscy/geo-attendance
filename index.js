// The background geofence task must be defined before anything else loads,
// so the phone can run it even when the app is closed.
import './src/attendance';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
