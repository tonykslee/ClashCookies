# ClanWarMember


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**tag** | **string** |  | [optional] [readonly] [default to undefined]
**name** | **string** |  | [optional] [readonly] [default to undefined]
**mapPosition** | **number** |  | [optional] [readonly] [default to undefined]
**townhallLevel** | **number** |  | [optional] [readonly] [default to undefined]
**opponentAttacks** | **number** |  | [optional] [readonly] [default to undefined]
**bestOpponentAttack** | [**ClanWarAttack**](ClanWarAttack.md) |  | [optional] [readonly] [default to undefined]
**attacks** | [**Array&lt;ClanWarAttack&gt;**](ClanWarAttack.md) |  | [optional] [readonly] [default to undefined]

## Example

```typescript
import { ClanWarMember } from './api';

const instance: ClanWarMember = {
    tag,
    name,
    mapPosition,
    townhallLevel,
    opponentAttacks,
    bestOpponentAttack,
    attacks,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
