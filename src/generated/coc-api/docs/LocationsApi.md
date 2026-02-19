# LocationsApi

All URIs are relative to *https://api.clashofclans.com/v1*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getClanRanking**](#getclanranking) | **GET** /locations/{locationId}/rankings/clans | Get clan rankings for a specific location|
|[**getClanVersusRanking**](#getclanversusranking) | **GET** /locations/{locationId}/rankings/clans-versus | Get clan versus rankings for a specific location|
|[**getLocation**](#getlocation) | **GET** /locations/{locationId} | Get location information|
|[**getLocations**](#getlocations) | **GET** /locations | List locations|
|[**getPlayerRanking**](#getplayerranking) | **GET** /locations/{locationId}/rankings/players | Get player rankings for a specific location|
|[**getPlayerVersusRanking**](#getplayerversusranking) | **GET** /locations/{locationId}/rankings/players-versus | Get player versus rankings for a specific location|

# **getClanRanking**
> ClanRankingList getClanRanking()

Get clan rankings for a specific location

### Example

```typescript
import {
    LocationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LocationsApi(configuration);

let locationId: string; //Identifier of the location to retrieve. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getClanRanking(
    locationId,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **locationId** | [**string**] | Identifier of the location to retrieve. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**ClanRankingList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getClanVersusRanking**
> ClanVersusRankingList getClanVersusRanking()

Get clan versus rankings for a specific location

### Example

```typescript
import {
    LocationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LocationsApi(configuration);

let locationId: string; //Identifier of the location to retrieve. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getClanVersusRanking(
    locationId,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **locationId** | [**string**] | Identifier of the location to retrieve. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**ClanVersusRankingList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getLocation**
> Location getLocation()

Get information about specific location

### Example

```typescript
import {
    LocationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LocationsApi(configuration);

let locationId: string; //Identifier of the location to retrieve. (default to undefined)

const { status, data } = await apiInstance.getLocation(
    locationId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **locationId** | [**string**] | Identifier of the location to retrieve. | defaults to undefined|


### Return type

**Location**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getLocations**
> LocationList getLocations()

List locations

### Example

```typescript
import {
    LocationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LocationsApi(configuration);

let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getLocations(
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**LocationList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getPlayerRanking**
> PlayerRankingList getPlayerRanking()

Get player rankings for a specific location

### Example

```typescript
import {
    LocationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LocationsApi(configuration);

let locationId: string; //Identifier of the location to retrieve. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getPlayerRanking(
    locationId,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **locationId** | [**string**] | Identifier of the location to retrieve. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**PlayerRankingList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getPlayerVersusRanking**
> PlayerVersusRankingList getPlayerVersusRanking()

Get player versus rankings for a specific location

### Example

```typescript
import {
    LocationsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LocationsApi(configuration);

let locationId: string; //Identifier of the location to retrieve. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getPlayerVersusRanking(
    locationId,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **locationId** | [**string**] | Identifier of the location to retrieve. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**PlayerVersusRankingList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

