# ClansApi

All URIs are relative to *https://api.clashofclans.com/v1*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getClan**](#getclan) | **GET** /clans/{clanTag} | Get clan information|
|[**getClanMembers**](#getclanmembers) | **GET** /clans/{clanTag}/members | List clan members|
|[**getClanWarLeagueGroup**](#getclanwarleaguegroup) | **GET** /clans/{clanTag}/currentwar/leaguegroup | Retrieve information about clan\&#39;s current clan war league group|
|[**getClanWarLeagueWar**](#getclanwarleaguewar) | **GET** /clanwarleagues/wars/{warTag} | Retrieve information about individual clan war league war|
|[**getClanWarLog**](#getclanwarlog) | **GET** /clans/{clanTag}/warlog | Retrieve clan\&#39;s clan war log|
|[**getCurrentWar**](#getcurrentwar) | **GET** /clans/{clanTag}/currentwar | Retrieve information about clan\&#39;s current clan war|
|[**searchClans**](#searchclans) | **GET** /clans | Search clans|

# **getClan**
> Clan getClan()

Get information about a single clan by clan tag. Clan tags can be found using clan search operation. Note that clan tags start with hash character \'#\' and that needs to be URL-encoded properly to work in URL, so for example clan tag \'#2ABC\' would become \'%232ABC\' in the URL. 

### Example

```typescript
import {
    ClansApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ClansApi(configuration);

let clanTag: string; //Tag of the clan. (default to undefined)

const { status, data } = await apiInstance.getClan(
    clanTag
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **clanTag** | [**string**] | Tag of the clan. | defaults to undefined|


### Return type

**Clan**

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

# **getClanMembers**
> Array<ClanMember> getClanMembers()

List clan members.

### Example

```typescript
import {
    ClansApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ClansApi(configuration);

let clanTag: string; //Tag of the clan. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getClanMembers(
    clanTag,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **clanTag** | [**string**] | Tag of the clan. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**Array<ClanMember>**

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

# **getClanWarLeagueGroup**
> ClanWarLeagueGroup getClanWarLeagueGroup()

Retrieve information about clan\'s current clan war league group

### Example

```typescript
import {
    ClansApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ClansApi(configuration);

let clanTag: string; //Tag of the clan. (default to undefined)

const { status, data } = await apiInstance.getClanWarLeagueGroup(
    clanTag
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **clanTag** | [**string**] | Tag of the clan. | defaults to undefined|


### Return type

**ClanWarLeagueGroup**

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

# **getClanWarLeagueWar**
> ClanWar getClanWarLeagueWar()

Retrieve information about individual clan war league war

### Example

```typescript
import {
    ClansApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ClansApi(configuration);

let warTag: string; //Tag of the war. (default to undefined)

const { status, data } = await apiInstance.getClanWarLeagueWar(
    warTag
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **warTag** | [**string**] | Tag of the war. | defaults to undefined|


### Return type

**ClanWar**

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

# **getClanWarLog**
> ClanWarLog getClanWarLog()

Retrieve clan\'s clan war log

### Example

```typescript
import {
    ClansApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ClansApi(configuration);

let clanTag: string; //Tag of the clan. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getClanWarLog(
    clanTag,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **clanTag** | [**string**] | Tag of the clan. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**ClanWarLog**

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

# **getCurrentWar**
> ClanWar getCurrentWar()

Retrieve information about clan\'s current clan war

### Example

```typescript
import {
    ClansApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ClansApi(configuration);

let clanTag: string; //Tag of the clan. (default to undefined)

const { status, data } = await apiInstance.getCurrentWar(
    clanTag
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **clanTag** | [**string**] | Tag of the clan. | defaults to undefined|


### Return type

**ClanWar**

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

# **searchClans**
> ClanList searchClans()

Search all clans by name and/or filtering the results using various criteria. At least one filtering criteria must be defined and if name is used as part of search, it is required to be at least three characters long. It is not possible to specify ordering for results so clients should not rely on any specific ordering as that may change in the future releases of the API. 

### Example

```typescript
import {
    ClansApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ClansApi(configuration);

let name: string; //Search clans by name. If name is used as part of search query, it needs to be at least three characters long. Name search parameter is interpreted as wild card search, so it may appear anywhere in the clan name.  (optional) (default to undefined)
let warFrequency: string; //Filter by clan war frequency (optional) (default to undefined)
let locationId: number; //Filter by clan location identifier. For list of available locations, refer to getLocations operation.  (optional) (default to undefined)
let minMembers: number; //Filter by minimum number of clan members (optional) (default to undefined)
let maxMembers: number; //Filter by maximum number of clan members (optional) (default to undefined)
let minClanPoints: number; //Filter by minimum amount of clan points. (optional) (default to undefined)
let minClanLevel: number; //Filter by minimum clan level. (optional) (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let labelIds: string; //Comma separatered list of label IDs to use for filtering results. (optional) (default to undefined)

const { status, data } = await apiInstance.searchClans(
    name,
    warFrequency,
    locationId,
    minMembers,
    maxMembers,
    minClanPoints,
    minClanLevel,
    limit,
    after,
    before,
    labelIds
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **name** | [**string**] | Search clans by name. If name is used as part of search query, it needs to be at least three characters long. Name search parameter is interpreted as wild card search, so it may appear anywhere in the clan name.  | (optional) defaults to undefined|
| **warFrequency** | [**string**] | Filter by clan war frequency | (optional) defaults to undefined|
| **locationId** | [**number**] | Filter by clan location identifier. For list of available locations, refer to getLocations operation.  | (optional) defaults to undefined|
| **minMembers** | [**number**] | Filter by minimum number of clan members | (optional) defaults to undefined|
| **maxMembers** | [**number**] | Filter by maximum number of clan members | (optional) defaults to undefined|
| **minClanPoints** | [**number**] | Filter by minimum amount of clan points. | (optional) defaults to undefined|
| **minClanLevel** | [**number**] | Filter by minimum clan level. | (optional) defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **labelIds** | [**string**] | Comma separatered list of label IDs to use for filtering results. | (optional) defaults to undefined|


### Return type

**ClanList**

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

